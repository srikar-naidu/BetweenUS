import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { visibleMomentsForMember } from "@/lib/auth/group-visibility";
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
    const visibleMoments = visibleMomentsForMember(moments, fragments);

    return Response.json(
      { moments: visibleMoments },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}