import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { getTemporalClient, getTemporalSettings, startFragmentWorkflow, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { isPrivateObjectStorageConfigured, ObjectStorageConfigurationError } from "@/lib/storage/r2-object-store";

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
    const repository = new MongoMemoryRepository(database);
    const ingestionRepository = new MongoIngestionRepository(database);
    const [activeUploads, pendingFragmentsBeforeRequest] = await Promise.all([
      ingestionRepository.findActiveUploadedFragments(groupId),
      ingestionRepository.findPendingGroupFragments(groupId),
    ]);
    const uploadedFragments = [
      ...new Map(
        [...activeUploads, ...pendingFragmentsBeforeRequest.filter((fragment) => fragment.source === "upload")]
          .map((fragment) => [fragment.id, fragment]),
      ).values(),
    ];
    if (uploadedFragments.length && !getTemporalSettings()) {
      throw new TemporalConfigurationError();
    }
    if (uploadedFragments.length && !isPrivateObjectStorageConfigured()) {
      throw new ObjectStorageConfigurationError();
    }
    if (uploadedFragments.length) await getTemporalClient();
    const requested = await repository.requestGroupDeletion({
      groupId,
      requestedByUserId: session.user.id,
    });
    if (!requested) return Response.json({ error: "Group not found" }, { status: 404 });
    if (process.env.TIGER_DATABASE_URL) {
      await new TigerDataFragmentSearch().removeGroupFragments(groupId);
    }
    const pendingFragments = await ingestionRepository.findPendingGroupFragments(groupId);
    for (const fragment of pendingFragments) {
      if (fragment.source !== "upload") {
        await ingestionRepository.markFragmentDeletionComplete(groupId, fragment.id);
        continue;
      }
      const job = await ingestionRepository.upsertProcessingJob({
        groupId,
        fragmentId: fragment.id,
        jobType: "delete_fragment",
        processingVersion: fragment.processingVersion,
      });
      try {
        await startFragmentWorkflow(job, "deleteFragmentWorkflow");
      } catch {
        await ingestionRepository.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
      }
    }
    await ingestionRepository.completeGroupDeletionIfNoPendingFragments(groupId);
    return Response.json({ status: "deletion_pending" }, { status: 202 });
  } catch (error) {
    if (error instanceof TemporalConfigurationError) {
      return Response.json({ error: "Processing is not configured on this server" }, { status: 503 });
    }
    if (error instanceof ObjectStorageConfigurationError) {
      return Response.json({ error: "Private object storage is not configured" }, { status: 503 });
    }
    return apiErrorResponse(error);
  }
}