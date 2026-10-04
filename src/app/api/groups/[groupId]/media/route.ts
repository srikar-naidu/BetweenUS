import { createHash } from "node:crypto";
import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { FragmentInputError } from "@/lib/ingestion/fragment-validation";
import {
  MAX_IMAGE_FILE_BYTES,
  MAX_MEDIA_CAPTION_CHARACTERS,
  MAX_VIDEO_FILE_BYTES,
  validateGroupMedia,
  validateMediaCaption,
} from "@/lib/ingestion/media-validation";
import { validateVoiceCaptureMetadata } from "@/lib/ingestion/voice-validation";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { getTemporalClient, startFragmentWorkflow, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import {
  MongoIngestionRepository,
  type ProcessingJobStatus,
} from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { isManagedGroupMediaStorageUri, MongoGroupMediaStorage } from "@/lib/repositories/mongodb-group-media-storage";
import type { Fragment } from "@/lib/domain/memory";

export const runtime = "nodejs";

async function queueMediaAnalysis(
  database: Awaited<ReturnType<typeof getMongoDatabase>>,
  fragment: Fragment,
): Promise<ProcessingJobStatus | null> {
  if (!fragment.aiProcessingConsent) return null;
  const jobs = new MongoIngestionRepository(database);
  const job = await jobs.upsertProcessingJob({
    groupId: fragment.groupId,
    fragmentId: fragment.id,
    jobType: "ingest",
    processingVersion: fragment.processingVersion,
  });
  if (job.status !== "queued") return job.status;
  try {
    await getTemporalClient();
    await startFragmentWorkflow(job, "processFragmentWorkflow");
    return "queued";
  } catch (error) {
    if (!(error instanceof TemporalConfigurationError)) throw error;
    await jobs.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
    return "failed";
  }
}

async function readMediaBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  if (!request.body) throw new FragmentInputError("Choose a photo or video to upload");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new FragmentInputError("The selected media file is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const mediaType = request.headers.get("content-type") ?? "";
    const isImage = mediaType.startsWith("image/");
    const isVideo = mediaType.startsWith("video/");
    if (!isImage && !isVideo) {
      throw new FragmentInputError("Choose a JPEG, PNG, or WebP photo, or an MP4 or WebM video");
    }
    const maximumBytes = isImage ? MAX_IMAGE_FILE_BYTES : MAX_VIDEO_FILE_BYTES;
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maximumBytes) {
      return Response.json(
        { error: isImage ? "Photos must be smaller than 12 MB" : "Videos must be smaller than 25 MB" },
        { status: 413 },
      );
    }

    const { capturedAt, capturedTimeZone } = validateVoiceCaptureMetadata({
      capturedAt: request.headers.get("x-captured-at") ?? "",
      capturedTimeZone: request.headers.get("x-captured-time-zone") ?? "",
    });
    const visibilityValue = "group" as const;
    const encodedCaption = request.headers.get("x-fragment-caption") ?? "";
    if (encodedCaption.length > MAX_MEDIA_CAPTION_CHARACTERS * 3) {
      throw new FragmentInputError("Captions must be 1,000 characters or fewer");
    }
    let caption: string | null;
    try {
      caption = validateMediaCaption(decodeURIComponent(encodedCaption));
    } catch (error) {
      if (error instanceof URIError) throw new FragmentInputError("Caption contains invalid text");
      throw error;
    }
    const bytes = await readMediaBytes(request, maximumBytes);
    const media = validateGroupMedia(bytes, mediaType);
    const consentHeader = request.headers.get("x-ai-processing-consent");
    if (consentHeader !== null && consentHeader !== "true" && consentHeader !== "false") {
      throw new FragmentInputError("AI processing consent must be explicit");
    }
    const aiProcessingConsent = consentHeader === "true";
    const requestId = request.headers.get("Idempotency-Key");
    if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      throw new FragmentInputError("A UUID Idempotency-Key is required");
    }
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const fragmentId = createHash("sha256")
      .update(`${groupId}\0${session.user.id}\0${requestId}`)
      .digest("hex");
    const database = await getMongoDatabase();
    const repository = new MongoMemoryRepository(database);
    const existing = await repository.findFragmentById(groupId, fragmentId);
    if (existing) {
      if (
        existing.authorUserId !== session.user.id ||
        existing.type !== media.type ||
        existing.source !== "upload" ||
        existing.checksumSha256 !== checksumSha256 ||
        existing.capturedAt.getTime() !== capturedAt.getTime() ||
        existing.capturedTimeZone !== capturedTimeZone ||
        existing.visibility !== visibilityValue ||
        existing.caption !== caption ||
        existing.aiProcessingConsent !== aiProcessingConsent
      ) {
        return Response.json({ error: "Idempotency key was already used for different media" }, { status: 409 });
      }
      const processingStatus = await queueMediaAnalysis(database, existing);
      const { storageUri: hiddenStorageUri, ...visibleFragment } = existing;
      void hiddenStorageUri;
      return Response.json({
        fragment: {
          ...visibleFragment,
          processingJobStatus: processingStatus,
          mediaStorageAvailable: Boolean(existing.storageUri && isManagedGroupMediaStorageUri(existing.storageUri)),
        },
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const storage = new MongoGroupMediaStorage(database);
    const storageUri = await storage.save(bytes, {
      groupId,
      fragmentId,
      authorUserId: session.user.id,
      media,
    });
    let fragment: Fragment;
    try {
      fragment = await repository.createFragment({
        id: fragmentId,
        groupId,
        authorUserId: session.user.id,
        type: media.type,
        source: "upload",
        storageUri,
        checksumSha256,
        caption,
        capturedAt,
        capturedTimeZone,
        metadata: {
          fileSizeBytes: media.fileSizeBytes,
          mimeType: media.mimeType,
        },
        visibility: visibilityValue,
        aiProcessingConsent,
        transcriptionConsent: false,
        processingVersion: aiProcessingConsent
          ? `${FRAGMENT_ANALYSIS_VERSION}-${Date.now()}`
          : "media-upload-v1",
      });
    } catch (error) {
      await storage.delete(storageUri, { groupId, fragmentId });
      throw error;
    }
    if (
      fragment.authorUserId !== session.user.id ||
      fragment.type !== media.type ||
      fragment.checksumSha256 !== checksumSha256 ||
      fragment.capturedAt.getTime() !== capturedAt.getTime() ||
      fragment.capturedTimeZone !== capturedTimeZone ||
      fragment.visibility !== visibilityValue ||
      fragment.caption !== caption ||
      fragment.aiProcessingConsent !== aiProcessingConsent
    ) {
      await storage.delete(storageUri, { groupId, fragmentId });
      return Response.json({ error: "Idempotency key was already used for different media" }, { status: 409 });
    }
    if (fragment.storageUri !== storageUri && fragment.storageUri) {
      await storage.delete(storageUri, { groupId, fragmentId });
    }
    const processingStatus = await queueMediaAnalysis(database, fragment);
    const { storageUri: hiddenStorageUri, ...visibleFragment } = fragment;
    void hiddenStorageUri;
    return Response.json(
      {
        fragment: {
          ...visibleFragment,
          processingJobStatus: processingStatus,
          mediaStorageAvailable: true,
        },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof FragmentInputError) {
      const status = error.message.includes("too large") || error.message.includes("smaller than")
        ? 413
        : 400;
      return Response.json({ error: error.message }, { status });
    }
    return apiErrorResponse(error);
  }
}
