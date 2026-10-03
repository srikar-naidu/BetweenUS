import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import {
  FragmentInputError,
  inspectMediaBytes,
} from "@/lib/ingestion/fragment-validation";
import { getMongoDatabase } from "@/lib/db/mongodb";
import {
  getTemporalSettings,
  startFragmentWorkflow,
  TemporalConfigurationError,
} from "@/lib/processing/temporal-client";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import {
  createPresignedDownloadUrl,
  deletePrivateObject,
  isPrivateObjectStorageConfigured,
  ObjectStorageConfigurationError,
  readPrivateObject,
} from "@/lib/storage/r2-object-store";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string; uploadId: string }> },
) {
  try {
    const { groupId, uploadId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    if (!isPrivateObjectStorageConfigured()) throw new ObjectStorageConfigurationError();
    if (!getTemporalSettings()) throw new TemporalConfigurationError();

    const database = await getMongoDatabase();
    const ingestion = new MongoIngestionRepository(database);
    const reservation = await ingestion.findUploadReservation({
      groupId,
      authorUserId: session.user.id,
      uploadId,
    });
    if (!reservation) return Response.json({ error: "Upload reservation not found" }, { status: 404 });
    if (reservation.status === "completed" && reservation.fragmentId) {
      const job = await ingestion.findProcessingJob(
        groupId,
        `ingest:${groupId}:${reservation.fragmentId}:ingest-v1`,
      );
      return Response.json({
        fragmentId: reservation.fragmentId,
        jobId: job?.id ?? null,
        processingStatus: job?.status ?? "queued",
        downloadUrl: await createPresignedDownloadUrl(reservation.objectKey),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (reservation.status !== "issued" || reservation.expiresAt <= new Date()) {
      return Response.json({ error: "Upload reservation is no longer active" }, { status: 409 });
    }

    const stored = await readPrivateObject({
      key: reservation.objectKey,
      expectedSize: reservation.expectedSize,
    });
    if (stored.contentType?.split(";", 1)[0].trim().toLowerCase() !== reservation.contentType) {
      await ingestion.rejectUploadReservation({ groupId, authorUserId: session.user.id, uploadId });
      await deletePrivateObject(reservation.objectKey);
      return Response.json({ error: "Stored content type does not match the upload reservation" }, { status: 400 });
    }

    let inspected;
    try {
      inspected = await inspectMediaBytes(stored.bytes, reservation.contentType, reservation.type);
    } catch (error) {
      await ingestion.rejectUploadReservation({ groupId, authorUserId: session.user.id, uploadId });
      await deletePrivateObject(reservation.objectKey);
      throw error;
    }

    const fragment = await new MongoMemoryRepository(database).createFragment({
      id: reservation.id,
      groupId,
      authorUserId: session.user.id,
      type: reservation.type,
      storageUri: reservation.objectKey,
      caption: reservation.caption,
      textContent: null,
      source: "upload",
      capturedAt: reservation.capturedAt,
      capturedTimeZone: reservation.capturedTimeZone,
      checksumSha256: inspected.checksumSha256,
      processingVersion: "ingest-v1",
      metadata: {
        mimeType: inspected.contentType,
        fileSizeBytes: stored.bytes.length,
        ...(inspected.durationSeconds === undefined ? {} : { durationSeconds: inspected.durationSeconds }),
      },
      visibility: reservation.visibility,
      aiProcessingConsent: reservation.aiProcessingConsent,
    });
    await ingestion.completeUploadReservation({
      groupId,
      authorUserId: session.user.id,
      uploadId,
      fragmentId: fragment.id,
    });
    const job = await ingestion.upsertProcessingJob({
      groupId,
      fragmentId: fragment.id,
      jobType: "ingest",
      processingVersion: fragment.processingVersion,
    });
    let workflowId: string | null = null;
    try {
      workflowId = await startFragmentWorkflow(job, "processFragmentWorkflow");
    } catch {
      await ingestion.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
    }
    const { storageUri: _storageUri, ...visibleFragment } = fragment;
    return Response.json({
      fragment: visibleFragment,
      jobId: job.id,
      workflowId,
      processingStatus: workflowId ? "queued" : "failed",
      downloadUrl: await createPresignedDownloadUrl(reservation.objectKey),
    }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof FragmentInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ObjectStorageConfigurationError) {
      return Response.json({ error: "Private object storage is not configured" }, { status: 503 });
    }
    if (error instanceof TemporalConfigurationError) {
      return Response.json({ error: "Processing is not configured on this server" }, { status: 503 });
    }
    return apiErrorResponse(error);
  }
}
