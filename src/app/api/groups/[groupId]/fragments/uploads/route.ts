import { createHash } from "node:crypto";
import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { FragmentInputError, validateUploadDescriptor } from "@/lib/ingestion/fragment-validation";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { getTemporalSettings, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import {
  createPresignedUploadUrl,
  isPrivateObjectStorageConfigured,
  ObjectStorageConfigurationError,
} from "@/lib/storage/r2-object-store";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    const input = validateUploadDescriptor(body);
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
      return Response.json({ error: "A UUID Idempotency-Key is required" }, { status: 400 });
    }
    const uploadId = createHash("sha256")
      .update(`${groupId}\0${session.user.id}\0${idempotencyKey}`)
      .digest("hex");
    if (!isPrivateObjectStorageConfigured()) throw new ObjectStorageConfigurationError();
    if (!getTemporalSettings()) throw new TemporalConfigurationError();

    const repository = new MongoIngestionRepository(await getMongoDatabase());
    const existing = await repository.findUploadReservation({
      groupId,
      authorUserId: session.user.id,
      uploadId,
    });
    if (existing) {
      if (
        existing.type !== input.type ||
        existing.contentType !== input.contentType ||
        existing.expectedSize !== input.size ||
        existing.capturedAt.getTime() !== input.capturedAt.getTime() ||
        existing.capturedTimeZone !== input.capturedTimeZone ||
        existing.visibility !== input.visibility ||
        existing.aiProcessingConsent !== input.aiProcessingConsent ||
        existing.caption !== input.caption
      ) {
        return Response.json(
          { error: "Idempotency key was already used for different upload details" },
          { status: 409 },
        );
      }
      if (existing.status === "completed") {
        if (!existing.fragmentId) {
          return Response.json({ error: "Completed upload has no fragment record" }, { status: 409 });
        }
        const database = await getMongoDatabase();
        const fragment = await new MongoMemoryRepository(database).findFragmentById(groupId, existing.fragmentId);
        if (!fragment) return Response.json({ error: "Completed fragment is unavailable" }, { status: 404 });
        const jobId = `ingest:${groupId}:${existing.fragmentId}:ingest-v1`;
        const job = await new MongoIngestionRepository(database).findProcessingJob(groupId, jobId);
        const { storageUri: _storageUri, ...visibleFragment } = fragment;
        return Response.json(
          {
            uploadId,
            alreadyCompleted: true,
            fragment: { ...visibleFragment, processingJobStatus: job?.status ?? null },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (existing.status !== "issued" || existing.expiresAt <= new Date()) {
        return Response.json({ error: "Upload reservation is no longer active" }, { status: 409 });
      }
      const uploadUrl = await createPresignedUploadUrl({
        key: existing.objectKey,
        contentType: existing.contentType,
        size: existing.expectedSize,
      });
      return Response.json(
        { uploadId, uploadUrl, method: "PUT", contentType: existing.contentType, expiresInSeconds: 300 },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const now = new Date();
    const objectKey = `groups/${groupId}/fragments/${uploadId}`;
    const reservation = await repository.createUploadReservation({
      id: uploadId,
      groupId,
      authorUserId: session.user.id,
      objectKey,
      type: input.type,
      contentType: input.contentType,
      expectedSize: input.size,
      capturedAt: input.capturedAt,
      capturedTimeZone: input.capturedTimeZone,
      visibility: input.visibility,
      aiProcessingConsent: input.aiProcessingConsent,
      caption: input.caption,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      status: "issued",
      fragmentId: null,
      createdAt: now,
    });
    const uploadUrl = await createPresignedUploadUrl({
      key: reservation.objectKey,
      contentType: reservation.contentType,
      size: reservation.expectedSize,
    });
    return Response.json(
      { uploadId, uploadUrl, method: "PUT", contentType: reservation.contentType, expiresInSeconds: 300 },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
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
