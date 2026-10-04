import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { storyForGroupMember, visibleStoriesForMember } from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoStoryRepository } from "@/lib/repositories/mongodb-story-repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string; jobId: string }> },
) {
  try {
    const { groupId, jobId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const stories = new MongoStoryRepository(database);
    const job = await stories.findStoryJob(groupId, jobId);
    if (!job || job.requesterUserId !== session.user.id) {
      return Response.json({ error: "Story reconstruction job not found" }, { status: 404 });
    }
    if (job.status !== "succeeded" || !job.storyId) {
      return Response.json(
        { status: job.status, ...(job.status === "succeeded" ? { outcome: job.outcome } : {}) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const memory = new MongoMemoryRepository(database);
    const [story, moments] = await Promise.all([
      stories.findStory(groupId, job.storyId),
      memory.listMoments(groupId, 100),
    ]);
    if (!story) {
      return Response.json({ status: "succeeded", outcome: "insufficient_evidence" }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const fragmentIds = [...new Set([
      ...moments.flatMap((moment) => moment.evidence.map(({ fragmentId }) => fragmentId)),
      ...story.evidence.flatMap((item) => item.fragmentIds),
    ])];
    const fragments = await memory.findEligibleGroupVisibleFragmentsByIds(groupId, fragmentIds);
    const [visible] = visibleStoriesForMember([story], moments, fragments);
    return Response.json({
      status: "succeeded",
      outcome: visible ? "candidate" : "insufficient_evidence",
      ...(visible ? { story: storyForGroupMember(visible) } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
