import { ApplicationFailure } from "@temporalio/activity";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import {
  FRAGMENT_ANALYSIS_VERSION,
  generateOrReuseFragmentAnalysis,
  fragmentSourceDigest,
} from "@/lib/ai/fragment-analysis";
import { createGemmaService } from "@/lib/ai/gemma-provider";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { indexEligibleFragmentAnalysis } from "@/lib/retrieval/index-fragment-analysis";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { reconstructMoment } from "@/lib/pipeline/moment-reconstruction";
import { hasAnalyzableFragmentSource, hasApprovedTextSource } from "@/lib/domain/memory";
import {
  ElevenLabsApiError,
  ElevenLabsClient,
  ElevenLabsConfigurationError,
  getElevenLabsTranscriptionSettings,
} from "@/lib/integrations/elevenlabs-client";
import { MAX_VOICE_FILE_BYTES, validateVoiceClip } from "@/lib/ingestion/voice-validation";
import { MongoVoiceRepository } from "@/lib/repositories/mongodb-voice-repository";
import { MongoVoiceStorage } from "@/lib/repositories/mongodb-voice-storage";
import { isManagedGroupMediaStorageUri, MongoGroupMediaStorage } from "@/lib/repositories/mongodb-group-media-storage";
import { sampleVideoFrames } from "@/lib/ai/video-frames";
import { validateGroupMedia } from "@/lib/ingestion/media-validation";

export async function markProcessingJobStarted(input: {
  jobId: string;
  workflowId: string;
  groupId?: string;
  fragmentId?: string;
  fragmentStatus?: "processing";
}): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  await repository.markProcessingJobStarted({ id: input.jobId, workflowId: input.workflowId });
  if (input.fragmentStatus && input.groupId && input.fragmentId) {
    await new MongoMemoryRepository(database).updateFragmentStatus(
      input.groupId,
      input.fragmentId,
      input.fragmentStatus,
    );
  }
}

export async function verifyIngestedFragment(input: { groupId: string; fragmentId: string }): Promise<void> {
  const repository = new MongoMemoryRepository(await getMongoDatabase());
  const fragment = await repository.findFragmentById(input.groupId, input.fragmentId);
  if (!fragment || fragment.deletionState !== "active") {
    throw ApplicationFailure.nonRetryable("Fragment is unavailable for ingestion", "FragmentUnavailable");
  }
  if (!hasAnalyzableFragmentSource(fragment) || !fragment.aiProcessingConsent) {
    throw ApplicationFailure.nonRetryable("Fragment has no consented analysis source", "UnsupportedFragmentType");
  }
}

export async function analyzeFragment(input: {
  groupId: string;
  fragmentId: string;
}): Promise<{ analysisId: string; requiresReview: boolean } | null> {
  const database = await getMongoDatabase();
  const memory = new MongoMemoryRepository(database);
  const fragment = await memory.findFragmentById(input.groupId, input.fragmentId);
  if (!fragment || fragment.deletionState !== "active") {
    throw ApplicationFailure.nonRetryable("Fragment is unavailable for analysis", "FragmentUnavailable");
  }
  if (!hasAnalyzableFragmentSource(fragment)) {
    throw ApplicationFailure.nonRetryable("Fragment has no supported analysis source", "UnsupportedFragmentType");
  }
  if (!fragment.aiProcessingConsent) {
    throw ApplicationFailure.nonRetryable("Fragment AI consent was revoked", "FragmentConsentRevoked");
  }

  const analysisRepository = new MongoFragmentAnalysisRepository(database);
  const provider = createGemmaService();
  const existingAnalysis = await analysisRepository.find(
    input.groupId,
    input.fragmentId,
    FRAGMENT_ANALYSIS_VERSION,
  );
  const analysis = await generateOrReuseFragmentAnalysis({
    fragment,
    existingAnalysis,
    provider,
    loadMedia: async () => {
      if (
        (fragment.type !== "image" && fragment.type !== "video") ||
        !fragment.storageUri ||
        !isManagedGroupMediaStorageUri(fragment.storageUri) ||
        typeof fragment.metadata.mimeType !== "string"
      ) {
        throw ApplicationFailure.nonRetryable("Private media source is unavailable", "MediaSourceUnavailable");
      }
      const stored = await new MongoGroupMediaStorage(database).load({
        storageUri: fragment.storageUri,
        groupId: fragment.groupId,
        fragmentId: fragment.id,
        authorUserId: fragment.authorUserId,
        maximumBytes: fragment.type === "image" ? 12_000_000 : 25_000_000,
      });
      if (!stored) {
        throw ApplicationFailure.nonRetryable("Private media source is unavailable", "MediaSourceUnavailable");
      }
      const validated = validateGroupMedia(stored.bytes, stored.mimeType);
      const checksum = createHash("sha256").update(stored.bytes).digest("hex");
      if (checksum !== fragment.checksumSha256 || validated.type !== fragment.type) {
        throw ApplicationFailure.nonRetryable("Stored media no longer matches its fragment", "MediaSourceChanged");
      }
      if (fragment.type === "image") {
        return {
          images: [stored.bytes],
          evidenceLocators: ["whole_image"],
        };
      }
      const frames = await sampleVideoFrames(stored.bytes);
      return {
        images: frames.map((frame) => frame.bytes),
        evidenceLocators: frames.map((frame) => frame.locator),
      };
    },
  });
  const latest = await memory.findFragmentById(input.groupId, input.fragmentId);
  if (
    !latest ||
    latest.deletionState !== "active" ||
    !latest.aiProcessingConsent ||
    fragmentSourceDigest(latest) !== analysis.sourceContentSha256 ||
    latest.visibility !== fragment.visibility
  ) {
    throw ApplicationFailure.nonRetryable("Fragment eligibility changed during analysis", "FragmentEligibilityChanged");
  }

  await analysisRepository.save(analysis);
  try {
    await indexEligibleFragmentAnalysis(database, analysis);
  } catch (error) {
    await analysisRepository.delete(input.groupId, input.fragmentId);
    throw error;
  }
  const current = await memory.findFragmentById(input.groupId, input.fragmentId);
  if (!current || current.deletionState !== "active" || !current.aiProcessingConsent) {
    await analysisRepository.delete(input.groupId, input.fragmentId);
    if (process.env.TIGER_DATABASE_URL) {
      await new TigerDataFragmentSearch().removeGroupVisibleFragment(input.groupId, input.fragmentId);
    }
    return null;
  }
  return { analysisId: analysis.id, requiresReview: analysis.requiresReview };
}

export async function transcribeVoiceNote(input: {
  groupId: string;
  fragmentId: string;
}): Promise<void> {
  const database = await getMongoDatabase();
  const memory = new MongoMemoryRepository(database);
  const voices = new MongoVoiceRepository(database);
  const fragment = await memory.findFragmentById(input.groupId, input.fragmentId);
  const transcript = await voices.findTranscript(input.groupId, input.fragmentId);
  if (
    !fragment ||
    fragment.type !== "voice" ||
    fragment.source !== "upload" ||
    fragment.deletionState !== "active" ||
    fragment.transcriptionConsent !== true ||
    fragment.transcriptReviewedAt ||
    !fragment.storageUri ||
    transcript?.status !== "transcribing"
  ) {
    throw ApplicationFailure.nonRetryable("Voice note is no longer eligible for transcription", "VoiceNoteUnavailable");
  }
  const settings = getElevenLabsTranscriptionSettings();
  if (!settings) {
    await voices.markTranscriptFailed(input.groupId, input.fragmentId);
    throw ApplicationFailure.nonRetryable("Voice transcription is disabled", "VoiceTranscriptionDisabled");
  }

  try {
    const storage = new MongoVoiceStorage(database);
    const bytes = await storage.load({
      storageUri: fragment.storageUri,
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      authorUserId: fragment.authorUserId,
      maximumBytes: MAX_VOICE_FILE_BYTES,
    });
    if (!bytes) {
      throw ApplicationFailure.nonRetryable("Voice note audio is unavailable", "VoiceAudioUnavailable");
    }
    validateVoiceClip(bytes, "audio/wav");
    const beforeProviderCall = await memory.findFragmentById(input.groupId, input.fragmentId);
    if (
      !beforeProviderCall ||
      beforeProviderCall.deletionState !== "active" ||
      beforeProviderCall.transcriptionConsent !== true ||
      beforeProviderCall.storageUri !== fragment.storageUri
    ) {
      throw ApplicationFailure.nonRetryable("Voice note consent changed before transcription", "VoiceConsentChanged");
    }
    const result = await new ElevenLabsClient(settings).transcribe({ bytes });
    const latest = await memory.findFragmentById(input.groupId, input.fragmentId);
    const latestTranscript = await voices.findTranscript(input.groupId, input.fragmentId);
    if (
      !latest ||
      latest.deletionState !== "active" ||
      latest.transcriptionConsent !== true ||
      latest.storageUri !== fragment.storageUri ||
      latestTranscript?.status !== "transcribing"
    ) {
      throw ApplicationFailure.nonRetryable("Voice note consent changed during transcription", "VoiceConsentChanged");
    }
    const saved = await voices.saveTranscriptResult({
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      result,
    });
    if (!saved) {
      throw ApplicationFailure.nonRetryable("Voice transcript could not be saved", "VoiceTranscriptUnavailable");
    }
  } catch (error) {
    await voices.markTranscriptFailed(input.groupId, input.fragmentId);
    if (error instanceof ApplicationFailure) throw error;
    const category = error instanceof ElevenLabsApiError
      ? "ElevenLabsApiError"
      : error instanceof ElevenLabsConfigurationError
        ? "ElevenLabsConfigurationError"
        : error instanceof Error
          ? error.name
          : "VoiceTranscriptionError";
    throw ApplicationFailure.nonRetryable(
      `Voice transcription failed (${category})`,
      "VoiceTranscriptionFailed",
    );
  }
}

export async function reconstructMomentForFragment(input: {
  groupId: string;
  fragmentId: string;
  requesterUserId: string;
  momentId: string;
}): Promise<string> {
  if (!ObjectId.isValid(input.groupId) || !ObjectId.isValid(input.requesterUserId)) {
    throw ApplicationFailure.nonRetryable("Reconstruction requester is unavailable", "RequesterUnavailable");
  }
  const database = await getMongoDatabase();
  const [membership, group] = await Promise.all([
    database.collection("group_members").findOne({
      organizationId: new ObjectId(input.groupId),
      userId: new ObjectId(input.requesterUserId),
    }),
    database.collection("groups").findOne({
      _id: new ObjectId(input.groupId),
      lifecycleStatus: "active",
    }),
  ]);
  if (!membership || !group) {
    throw ApplicationFailure.nonRetryable("Reconstruction requester is no longer a group member", "MembershipUnavailable");
  }
  const result = await reconstructMoment({
    database,
    groupId: input.groupId,
    anchorFragmentId: input.fragmentId,
    viewerUserId: input.requesterUserId,
    momentId: input.momentId,
  });
  return result.moment.id;
}

export async function markProcessingJobSucceeded(input: {
  jobId: string;
  outputRef: string;
  groupId?: string;
  fragmentId?: string;
  fragmentStatus?: "processed" | "needs_review";
}): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  await repository.markProcessingJobSucceeded({ id: input.jobId, outputRef: input.outputRef });
  if (input.fragmentStatus && input.groupId && input.fragmentId) {
    await new MongoMemoryRepository(database).updateFragmentStatus(
      input.groupId,
      input.fragmentId,
      input.fragmentStatus,
    );
  }
}

export async function markProcessingJobFailed(input: {
  jobId: string;
  errorCategory: string;
  groupId?: string;
  fragmentId?: string;
  fragmentStatus?: "rejected";
}): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  await repository.markProcessingJobFailed({ id: input.jobId, errorMessage: input.errorCategory });
  if (input.fragmentStatus && input.groupId && input.fragmentId) {
    await new MongoMemoryRepository(database).updateFragmentStatus(
      input.groupId,
      input.fragmentId,
      input.fragmentStatus,
    );
  }
}

export async function deleteStoredFragment(input: { groupId: string; fragmentId: string }): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  const fragment = await repository.findFragmentForCleanup(input.groupId, input.fragmentId);
  if (!fragment) return;
  if (fragment.source === "upload" && fragment.type === "voice" && fragment.storageUri) {
    await new MongoVoiceStorage(database).delete(fragment.storageUri);
    await new MongoVoiceRepository(database).deleteTranscript(input.groupId, input.fragmentId);
  } else if (
    fragment.source === "upload" &&
    (fragment.type === "image" || fragment.type === "video") &&
    fragment.storageUri &&
    isManagedGroupMediaStorageUri(fragment.storageUri)
  ) {
    await new MongoGroupMediaStorage(database).delete(fragment.storageUri, {
      groupId: input.groupId,
      fragmentId: input.fragmentId,
    });
  } else if (fragment.source === "upload" && fragment.storageUri) {
    throw ApplicationFailure.nonRetryable(
      "Legacy media storage is unavailable; remove the object manually",
      "LegacyMediaCleanupRequired",
    );
  }
  await new MongoFragmentAnalysisRepository(database).delete(input.groupId, input.fragmentId);
  if (process.env.TIGER_DATABASE_URL) {
    await new TigerDataFragmentSearch().removeGroupVisibleFragment(input.groupId, input.fragmentId);
  }
  await repository.markFragmentDeletionComplete(input.groupId, input.fragmentId);
}
