import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const repository = new MongoMemoryRepository(await getMongoDatabase());
    const [moments, fragments] = await Promise.all([
      repository.listMoments(groupId),
      repository.findMemberVisibleFragments(groupId, session.user.id, 1000),
    ]);
    const eligibleFragmentIds = new Set(
      fragments
        .filter((fragment) => fragment.visibility === "group" && fragment.aiProcessingConsent)
        .map((fragment) => fragment.id),
    );
    const visibleMoments = moments.filter(
      (moment) =>
        (moment.status === "candidate" || moment.status === "confirmed") &&
        moment.evidence.length > 0 &&
        moment.evidence.every((item) => eligibleFragmentIds.has(item.fragmentId)),
    );

    return Response.json(
      { moments: visibleMoments },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}