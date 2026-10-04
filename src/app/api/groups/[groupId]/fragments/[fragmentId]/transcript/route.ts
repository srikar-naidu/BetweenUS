import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { isFragmentVisibility, MAX_VOICE_TRANSCRIPT_CHARACTERS } from "@/lib/ingestion/voice-validation";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoVoiceRepository } from "@/lib/repositories/mongodb-voice-repository";
import type { Fragment } from "@/lib/domain/memory";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string; fragmentId: string }> },
) {
  try {
    const { groupId, fragmentId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const fragment = await new MongoMemoryRepository(database).findFragmentById(groupId, fragmentId);
    if (
      !fragment ||
      fragment.deletionState !== "active" ||
      fragment.authorUserId !== session.user.id ||
      fragment.type !== "voice"
    ) {
      return Response.json({ error: "Voice note not found" }, { status: 404 });
    }
    const transcript = await new MongoVoiceRepository(database).findTranscript(groupId, fragmentId);
    if (!transcript) return Response.json({ error: "Voice transcript is unavailable" }, { status: 404 });
    return Response.json({
      status: transcript.status,
      transcript: transcript.transcript,
      words: transcript.words,
      languageCode: transcript.languageCode,
      manualReason: transcript.manualReason,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string; fragmentId: string }> },
) {
  try {
    const { groupId, fragmentId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Invalid transcript review" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    const transcriptText = input.transcript;
    const visibility = input.visibility;
    const aiProcessingConsent = input.aiProcessingConsent;
    if (
      typeof transcriptText !== "string" ||
      !transcriptText.trim() ||
      transcriptText.length > MAX_VOICE_TRANSCRIPT_CHARACTERS ||
      !isFragmentVisibility(visibility) ||
      typeof aiProcessingConsent !== "boolean"
    ) {
      return Response.json({ error: "Transcript, visibility, and AI consent are required" }, { status: 400 });
    }

    const database = await getMongoDatabase();
    const memory = new MongoMemoryRepository(database);
    const fragment = await memory.findFragmentById(groupId, fragmentId);
    if (
      !fragment ||
      fragment.authorUserId !== session.user.id ||
      fragment.type !== "voice" ||
      fragment.deletionState !== "active" ||
      fragment.transcriptReviewedAt
    ) {
      return Response.json({ error: "Voice note is not available for transcript review" }, { status: 404 });
    }
    const voiceRepository = new MongoVoiceRepository(database);
    const transcriptRecord = await voiceRepository.findTranscript(groupId, fragmentId);
    if (
      !transcriptRecord ||
      !["manual_review", "pending_review", "failed"].includes(transcriptRecord.status)
    ) {
      return Response.json({ error: "Voice transcript is not ready for review" }, { status: 409 });
    }
    const reviewedAt = new Date();
    const sessionTransaction = database.client.startSession();
    const reviewState: { fragment: Fragment | null } = { fragment: null };
    try {
      await sessionTransaction.withTransaction(async () => {
        const reviewed = await voiceRepository.markTranscriptReviewed({
          groupId,
          fragmentId,
          authorUserId: session.user.id,
        }, sessionTransaction);
        if (!reviewed) throw new Error("Voice transcript changed while being reviewed");
        reviewState.fragment = await memory.reviewVoiceTranscript({
          groupId,
          fragmentId,
          authorUserId: session.user.id,
          transcript: transcriptText.trim(),
          visibility,
          aiProcessingConsent,
          processingVersion: `${FRAGMENT_ANALYSIS_VERSION}-${reviewedAt.getTime()}`,
        }, sessionTransaction);
        if (!reviewState.fragment) throw new Error("Voice note changed while being reviewed");
      });
    } finally {
      await sessionTransaction.endSession();
    }
    const reviewedFragment = reviewState.fragment;
    if (!reviewedFragment) return Response.json({ error: "Voice transcript could not be saved" }, { status: 409 });

    let processingStatus = null;
    let jobId: string | null = null;
    let workflowId: string | null = null;
    if (aiProcessingConsent) {
      const jobs = new MongoIngestionRepository(database);
      const job = await jobs.upsertProcessingJob({
        groupId,
        fragmentId,
        jobType: "ingest",
        processingVersion: reviewedFragment.processingVersion,
      });
      jobId = job.id;
      workflowId = job.id;
      processingStatus = job.status;
    }
    const { storageUri: _storageUri, ...visibleFragment } = reviewedFragment;
    return Response.json({
      fragment: { ...visibleFragment, processingJobStatus: processingStatus },
      jobId,
      workflowId,
      processingStatus,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
