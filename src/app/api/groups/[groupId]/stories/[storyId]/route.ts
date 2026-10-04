import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { storyForGroupMember, visibleStoriesForMember } from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoStoryRepository } from "@/lib/repositories/mongodb-story-repository";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string; storyId: string }> },
) {
  try {
    const { groupId, storyId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "A Story review action is required" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (
      (input.action !== "confirm" && input.action !== "reject") ||
      !Number.isSafeInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 0
    ) {
      return Response.json({ error: "A valid Story review action and revision are required" }, { status: 400 });
    }
    const database = await getMongoDatabase();
    const storyRepository = new MongoStoryRepository(database);
    const existing = await storyRepository.findStory(groupId, storyId);
    if (!existing || existing.status !== "candidate") {
      return Response.json({ error: "A reviewable Story was not found" }, { status: 404 });
    }
    const memory = new MongoMemoryRepository(database);
    const [moments, fragments] = await Promise.all([
      memory.listMoments(groupId, 100),
      memory.findEligibleGroupVisibleFragmentsByIds(
        groupId,
        [...new Set(existing.evidence.flatMap((item) => item.fragmentIds))],
      ),
    ]);
    if (!visibleStoriesForMember([existing], moments, fragments).length) {
      return Response.json({ error: "Story evidence is no longer available for review" }, { status: 409 });
    }
    const updated = await storyRepository.reviewStory({
      groupId,
      storyId,
      actorUserId: session.user.id,
      action: input.action,
      expectedRevision: input.expectedRevision as number,
    });
    if (!updated) {
      return Response.json({ error: "Story changed while the review was being saved" }, { status: 409 });
    }
    return Response.json(
      { story: storyForGroupMember(updated) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
