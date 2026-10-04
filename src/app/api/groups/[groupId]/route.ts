import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { disableGroupBackboard } from "@/lib/pipeline/group-backboard-memory";
import { MongoVoiceStorage } from "@/lib/repositories/mongodb-voice-storage";
import { MongoVoiceRepository } from "@/lib/repositories/mongodb-voice-repository";
import { MongoStoryRepository } from "@/lib/repositories/mongodb-story-repository";
import { MongoEventStoryRepository } from "@/lib/repositories/mongodb-event-story-repository";
import { isManagedGroupMediaStorageUri, MongoGroupMediaStorage } from "@/lib/repositories/mongodb-group-media-storage";

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
    await new MongoStoryRepository(database).deleteGroup(groupId);
    await new MongoEventStoryRepository(database).deleteGroup(groupId);
    if (process.env.TIGER_DATABASE_URL) {
      await new TigerDataFragmentSearch().removeGroupFragments(groupId);
    }
    await new MongoFragmentAnalysisRepository(database).deleteGroup(groupId);
    const pendingFragments = await ingestionRepository.findPendingGroupFragments(groupId);
    const legacyMediaCleanupRequired = pendingFragments.some(
      (fragment) =>
        fragment.source === "upload" &&
        fragment.type !== "voice" &&
        fragment.storageUri !== null &&
        !((fragment.type === "image" || fragment.type === "video") &&
          isManagedGroupMediaStorageUri(fragment.storageUri)),
    );
    for (const fragment of pendingFragments) {
      if (fragment.type === "voice" && fragment.storageUri) {
        await new MongoVoiceStorage(database).delete(fragment.storageUri);
        await new MongoVoiceRepository(database).deleteTranscript(groupId, fragment.id);
      } else if (
        (fragment.type === "image" || fragment.type === "video") &&
        fragment.source === "upload" &&
        fragment.storageUri &&
        isManagedGroupMediaStorageUri(fragment.storageUri)
      ) {
        await new MongoGroupMediaStorage(database).delete(fragment.storageUri, {
          groupId,
          fragmentId: fragment.id,
        });
      }
      await ingestionRepository.markFragmentDeletionComplete(groupId, fragment.id);
    }
    await new MongoVoiceRepository(database).deleteGroupTranscripts(groupId);
    await ingestionRepository.completeGroupDeletionIfNoPendingFragments(groupId);
    await new MongoStoryRepository(database).deleteGroup(groupId);
    return Response.json({ status: "deletion_pending", legacyMediaCleanupRequired }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}