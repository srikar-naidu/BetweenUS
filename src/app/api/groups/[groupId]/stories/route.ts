import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { storyForGroupMember, visibleStoriesForMember } from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { TemporalConfigurationError, getTemporalClient, startStoryReconstructionWorkflow } from "@/lib/processing/temporal-client";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoStoryRepository } from "@/lib/repositories/mongodb-story-repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const memory = new MongoMemoryRepository(database);
    const [stories, moments] = await Promise.all([
      new MongoStoryRepository(database).listStories(groupId),
      memory.listMoments(groupId, 100),
    ]);
    const fragmentIds = [...new Set([
      ...moments.flatMap((moment) => moment.evidence.map(({ fragmentId }) => fragmentId)),
      ...stories.flatMap((story) => story.evidence.flatMap((item) => item.fragmentIds)),
    ])];
    const fragments = await memory.findEligibleGroupVisibleFragmentsByIds(groupId, fragmentIds);
    const visible = visibleStoriesForMember(stories, moments, fragments);
    return Response.json(
      { stories: visible.map(storyForGroupMember) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const requestId = request.headers.get("Idempotency-Key");
    if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      return Response.json({ error: "A UUID Idempotency-Key is required" }, { status: 400 });
    }
    const database = await getMongoDatabase();
    const memory = new MongoMemoryRepository(database);
    const confirmedMoments = (await memory.listMoments(groupId, 100))
      .filter((moment) => moment.status === "confirmed");
    if (confirmedMoments.length < 2) {
      return Response.json(
        { error: "Confirm at least two Moments before finding Story connections" },
        { status: 409 },
      );
    }
    await getTemporalClient();
    const repository = new MongoStoryRepository(database);
    const job = await repository.createStoryJob({
      groupId,
      requesterUserId: session.user.id,
      requestId,
    });
    if (job.requesterUserId !== session.user.id) {
      return Response.json({ error: "Story reconstruction request not found" }, { status: 404 });
    }
    if (job.status === "queued") {
      try {
        await startStoryReconstructionWorkflow(job);
      } catch {
        await repository.markStoryJobFailed({
          groupId,
          jobId: job.id,
          errorCategory: "temporal_unavailable",
        });
        return Response.json({ error: "Story reconstruction could not be queued" }, { status: 503 });
      }
    }
    return Response.json(
      { jobId: job.id, status: job.status },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TemporalConfigurationError) {
      return Response.json({ error: "Processing is not configured on this server" }, { status: 503 });
    }
    return apiErrorResponse(error);
  }
}
