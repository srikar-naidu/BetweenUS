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
    const fragments = await repository.findMemberVisibleFragments(groupId, session.user.id);

    return Response.json(
      {
        fragments: fragments.map(({ storageUri: _storageUri, ...fragment }) => fragment),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}