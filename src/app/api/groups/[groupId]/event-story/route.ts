import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { confirmedMomentsForEventStory } from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoEventStoryRepository } from "@/lib/repositories/mongodb-event-story-repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId);
    const story = await new MongoEventStoryRepository(await getMongoDatabase()).find(groupId);
    return Response.json({
      story: story ? {
        title: story.title,
        narrative: story.narrative,
        momentIds: story.momentIds,
        revision: story.revision,
        updatedAt: story.updatedAt,
      } : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "A story draft is required" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.title !== "string" ||
      input.title.trim().length < 2 ||
      input.title.trim().length > 120 ||
      typeof input.narrative !== "string" ||
      input.narrative.length > 20_000 ||
      !Array.isArray(input.momentIds) ||
      input.momentIds.length > 100 ||
      !input.momentIds.every((id) => typeof id === "string") ||
      new Set(input.momentIds).size !== input.momentIds.length ||
      !Number.isInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 0
    ) {
      return Response.json({ error: "Story details are invalid" }, { status: 400 });
    }
    const database = await getMongoDatabase();
    const memory = new MongoMemoryRepository(database);
    const moments = await memory.listMoments(groupId, 100);
    const evidenceFragmentIds = [...new Set(moments.flatMap((moment) =>
      moment.evidence.map((evidence) => evidence.fragmentId),
    ))];
    const eligibleFragments = await memory.findEligibleGroupVisibleFragmentsByIds(groupId, evidenceFragmentIds);
    const confirmedMoments = confirmedMomentsForEventStory(moments, eligibleFragments);
    const confirmedIds = new Set(confirmedMoments.map((moment) => moment.id));
    if (!(input.momentIds as string[]).every((id) => confirmedIds.has(id))) {
      return Response.json({ error: "Only confirmed Moments from this album can be included" }, { status: 409 });
    }
    const story = await new MongoEventStoryRepository(database).save({
      groupId,
      title: input.title.trim(),
      narrative: input.narrative.trim(),
      momentIds: input.momentIds as string[],
      updatedBy: session.user.id,
      expectedRevision: input.expectedRevision as number,
    });
    if (!story) {
      return Response.json({ error: "The story changed in another session. Reload and try again." }, { status: 409 });
    }
    return Response.json({
      story: {
        title: story.title,
        narrative: story.narrative,
        momentIds: story.momentIds,
        revision: story.revision,
        updatedAt: story.updatedAt,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
