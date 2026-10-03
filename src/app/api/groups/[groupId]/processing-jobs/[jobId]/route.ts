import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { getTemporalClient, startFragmentWorkflow, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import { isPrivateObjectStorageConfigured, ObjectStorageConfigurationError } from "@/lib/storage/r2-object-store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string; jobId: string }> },
) {
  try {
    const { groupId, jobId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const repository = new MongoIngestionRepository(database);
    const job = await repository.findProcessingJob(groupId, jobId);
    if (!job) return Response.json({ error: "Processing job not found" }, { status: 404 });
    const fragment = await new MongoMemoryRepository(database).findFragmentById(groupId, job.fragmentId);
    if (
      !fragment ||
      fragment.deletionState !== "active" ||
      (fragment.visibility !== "group" && fragment.authorUserId !== session.user.id)
    ) {
      return Response.json({ error: "Processing job not found" }, { status: 404 });
    }
    return Response.json({
      status: job.status,
      attemptCount: job.attemptCount,
      updatedAt: job.updatedAt,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string; jobId: string }> },
) {
  try {
    const { groupId, jobId } = await context.params;
    const { session, membership } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const ingestion = new MongoIngestionRepository(database);
    const job = await ingestion.findProcessingJob(groupId, jobId);
    if (!job || job.status !== "failed") {
      return Response.json({ error: "A failed processing job was not found" }, { status: 404 });
    }
    if (
      job.jobType === "delete_fragment" &&
      membership.role !== "owner" &&
      membership.role !== "admin"
    ) {
      return Response.json({ error: "A failed processing job was not found" }, { status: 404 });
    }
    const memoryRepository = new MongoMemoryRepository(database);
    const fragment = await memoryRepository.findFragmentById(groupId, job.fragmentId);
    if (
      !fragment ||
      (job.jobType === "ingest" && fragment.deletionState !== "active") ||
      (job.jobType === "delete_fragment" && fragment.deletionState !== "pending") ||
      (job.jobType === "ingest" &&
        fragment.visibility !== "group" &&
        fragment.authorUserId !== session.user.id)
    ) {
      return Response.json({ error: "A failed processing job was not found" }, { status: 404 });
    }

    if (job.jobType === "delete_fragment" && !isPrivateObjectStorageConfigured()) {
      throw new ObjectStorageConfigurationError();
    }
    await getTemporalClient();
    const reset = await ingestion.resetFailedProcessingJobForRetry({
      groupId,
      id: job.id,
      jobType: job.jobType,
    });
    if (!reset) return Response.json({ error: "Processing job is already being retried" }, { status: 409 });
    if (job.jobType === "ingest") await memoryRepository.updateFragmentStatus(groupId, fragment.id, "uploaded");
    const queuedJob = await ingestion.findProcessingJob(groupId, job.id);
    if (!queuedJob) return Response.json({ error: "Processing job not found" }, { status: 404 });

    let workflowId: string;
    try {
      workflowId = await startFragmentWorkflow(
        queuedJob,
        job.jobType === "ingest" ? "processFragmentWorkflow" : "deleteFragmentWorkflow",
      );
    } catch {
      await ingestion.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
      if (job.jobType === "ingest") await memoryRepository.updateFragmentStatus(groupId, fragment.id, "rejected");
      return Response.json({ error: "Processing could not be restarted" }, { status: 503 });
    }
    return Response.json({ status: "queued", workflowId }, { status: 202, headers: { "Cache-Control": "no-store" } });
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
