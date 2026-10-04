import { createHash } from "node:crypto";
import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { FragmentInputError } from "@/lib/ingestion/fragment-validation";
import {
  MAX_VOICE_FILE_BYTES,
  validateVoiceCaptureMetadata,
  validateVoiceClip,
} from "@/lib/ingestion/voice-validation";
import { getElevenLabsTranscriptionSettings } from "@/lib/integrations/elevenlabs-client";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { getTemporalClient, startFragmentWorkflow, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoVoiceRepository } from "@/lib/repositories/mongodb-voice-repository";
import { MongoVoiceStorage } from "@/lib/repositories/mongodb-voice-storage";

export const runtime = "nodejs";

class VoiceUploadTooLargeError extends Error {
  constructor() {
    super("Voice upload exceeds the 2 MB size limit");
    this.name = "VoiceUploadTooLargeError";
  }
}

async function readVoiceBytes(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new FragmentInputError("A WAV voice note is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_VOICE_FILE_BYTES) {
        await reader.cancel();
        throw new VoiceUploadTooLargeError();
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
    const contentLengthValue = request.headers.get("content-length");
    const contentLength = contentLengthValue === null ? null : Number(contentLengthValue);
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_VOICE_FILE_BYTES) {
      return Response.json({ error: "Voice upload exceeds the 2 MB size limit" }, { status: 413 });
    }
    const consentValue = request.headers.get("x-transcription-consent");
    if (consentValue !== "true" && consentValue !== "false") {
      return Response.json({ error: "Choose whether to send this audio to ElevenLabs for transcription" }, { status: 400 });
    }
    const transcriptionConsent = consentValue === "true";
    const { capturedAt, capturedTimeZone } = validateVoiceCaptureMetadata({
      capturedAt: request.headers.get("x-captured-at") ?? "",
      capturedTimeZone: request.headers.get("x-captured-time-zone") ?? "",
    });
    const contentType = request.headers.get("content-type") ?? "";
    if (!["audio/wav", "audio/x-wav", "application/octet-stream"].includes(contentType)) {
      return Response.json({ error: "Voice notes must be uploaded as WAV audio" }, { status: 400 });
    }
    const bytes = await readVoiceBytes(request);
    const clip = validateVoiceClip(bytes, contentType);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const requestId = request.headers.get("Idempotency-Key");
    if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      return Response.json({ error: "A UUID Idempotency-Key is required" }, { status: 400 });
    }
    const fragmentId = createHash("sha256")
      .update(`${groupId}\0${session.user.id}\0${requestId}`)
      .digest("hex");
    const database = await getMongoDatabase();
    const memory = new MongoMemoryRepository(database);
    const existing = await memory.findFragmentById(groupId, fragmentId);
    if (existing) {
      if (
        existing.authorUserId !== session.user.id ||
        existing.type !== "voice" ||
        existing.checksumSha256 !== checksumSha256 ||
        existing.capturedAt.getTime() !== capturedAt.getTime() ||
        existing.capturedTimeZone !== capturedTimeZone ||
        existing.transcriptionConsent !== transcriptionConsent
      ) {
        return Response.json({ error: "Idempotency key was already used for a different voice note" }, { status: 409 });
      }
      const transcript = await new MongoVoiceRepository(database).findTranscript(groupId, fragmentId);
      const { storageUri: _storageUri, ...visibleFragment } = existing;
      return Response.json({
        fragment: visibleFragment,
        transcriptionStatus: transcript?.status ?? "manual_review",
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const settings = getElevenLabsTranscriptionSettings();
    let transcriptionReady = transcriptionConsent && settings !== null;
    let manualReason: "not_consented" | "provider_disabled" | "temporal_unavailable" | "monthly_limit" | null =
      transcriptionConsent ? settings ? null : "provider_disabled" : "not_consented";
    if (transcriptionReady) {
      try {
        await getTemporalClient();
      } catch (error) {
        if (!(error instanceof TemporalConfigurationError)) throw error;
        transcriptionReady = false;
        manualReason = "temporal_unavailable";
      }
    }

    const voices = new MongoVoiceRepository(database);
    let reservedByThisRequest = false;
    if (transcriptionReady && settings) {
      const reservation = await voices.reserveMonthlyUsage({
        fragmentId,
        seconds: Math.max(1, Math.ceil(clip.durationSeconds)),
        monthlySeconds: settings.monthlySeconds,
        monthlyRequests: settings.monthlyRequests,
      });
      transcriptionReady = reservation !== "exhausted";
      reservedByThisRequest = reservation === "reserved";
      if (!transcriptionReady) manualReason = "monthly_limit";
    }

    const storage = new MongoVoiceStorage(database);
    let storageUri: string | null = null;
    let fragmentCreated = false;
    try {
      storageUri = await storage.save(bytes, {
        groupId,
        fragmentId,
        authorUserId: session.user.id,
      });
      const fragment = await memory.createFragment({
        id: fragmentId,
        groupId,
        authorUserId: session.user.id,
        type: "voice",
        source: "upload",
        storageUri,
        checksumSha256,
        capturedAt,
        capturedTimeZone,
        metadata: {
          durationSeconds: clip.durationSeconds,
          fileSizeBytes: clip.fileSizeBytes,
          mimeType: clip.mimeType,
        },
        visibility: "private",
        aiProcessingConsent: false,
        transcriptionConsent,
        processingVersion: "voice-note-v1",
      });
      fragmentCreated = fragment.storageUri === storageUri;
      if (
        fragment.checksumSha256 !== checksumSha256 ||
        fragment.capturedAt.getTime() !== capturedAt.getTime() ||
        fragment.capturedTimeZone !== capturedTimeZone ||
        fragment.transcriptionConsent !== transcriptionConsent
      ) {
        await storage.delete(storageUri);
        return Response.json({ error: "Idempotency key was already used for a different voice note" }, { status: 409 });
      }
      if (!fragmentCreated && fragment.storageUri) await storage.delete(storageUri);
      const status = transcriptionReady ? "transcribing" : "manual_review";
      await voices.createTranscript({
        groupId,
        fragmentId,
        authorUserId: session.user.id,
        status,
        transcript: "",
        words: [],
        languageCode: null,
        manualReason,
      });
      let processingStatus = null;
      if (transcriptionReady) {
        const jobs = new MongoIngestionRepository(database);
        const job = await jobs.upsertProcessingJob({
          groupId,
          fragmentId,
          jobType: "transcribe_voice",
          processingVersion: "voice-transcription-v1",
        });
        try {
          await startFragmentWorkflow(job, "transcribeVoiceWorkflow");
          processingStatus = "queued";
        } catch {
          await jobs.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
          await voices.markTranscriptFailed(groupId, fragmentId);
          processingStatus = "failed";
        }
      }
      const { storageUri: _storageUri, ...visibleFragment } = fragment;
      return Response.json({
        fragment: visibleFragment,
        transcriptionStatus: transcriptionReady && processingStatus !== "failed"
          ? "transcribing"
          : transcriptionReady
            ? "failed"
            : "manual_review",
        manualReason: processingStatus === "failed" ? "temporal_unavailable" : manualReason,
        processingStatus,
      }, {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (storageUri && !fragmentCreated) await storage.delete(storageUri);
      if (reservedByThisRequest && !fragmentCreated) {
        const existing = await memory.findFragmentById(groupId, fragmentId);
        if (!existing) await voices.releaseMonthlyUsage(fragmentId);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof VoiceUploadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof FragmentInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
