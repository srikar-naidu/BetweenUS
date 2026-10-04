import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { disableGroupBackboard } from "@/lib/pipeline/group-backboard-memory";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(
      request.headers,
      groupId,
      ["owner"],
      { allowDeletionPending: true },
    );
    const database = await getMongoDatabase();
    await disableGroupBackboard({ database, groupId });
    const repository = new MongoMemoryRepository(database);
    const ingestionRepository = new MongoIngestionRepository(database);
    const requested = await repository.requestGroupDeletion({
      groupId,
      requestedByUserId: session.user.id,
    });
    if (!requested) return Response.json({ error: "Group not found" }, { status: 404 });
    if (process.env.TIGER_DATABASE_URL) {
      await new TigerDataFragmentSearch().removeGroupFragments(groupId);
    }
    await new MongoFragmentAnalysisRepository(database).deleteGroup(groupId);
    const pendingFragments = await ingestionRepository.findPendingGroupFragments(groupId);
    const legacyMediaCleanupRequired = pendingFragments.some(
      (fragment) => fragment.source === "upload" && fragment.storageUri !== null,
    );
    for (const fragment of pendingFragments) {
      await ingestionRepository.markFragmentDeletionComplete(groupId, fragment.id);
    }
    await ingestionRepository.completeGroupDeletionIfNoPendingFragments(groupId);
    return Response.json({ status: "deletion_pending", legacyMediaCleanupRequired }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}