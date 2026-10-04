import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { getTemporalClient, startFragmentWorkflow, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { indexEligibleFragmentAnalysis } from "@/lib/retrieval/index-fragment-analysis";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { deleteFragmentBackboardMemories } from "@/lib/pipeline/group-backboard-memory";
import { MongoVoiceStorage } from "@/lib/repositories/mongodb-voice-storage";
import { MongoVoiceRepository } from "@/lib/repositories/mongodb-voice-repository";
import { isManagedGroupMediaStorageUri, MongoGroupMediaStorage } from "@/lib/repositories/mongodb-group-media-storage";
import { hasAnalyzableFragmentSource, hasApprovedTextSource } from "@/lib/domain/memory";

export const runtime = "nodejs";

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
      return Response.json({ error: "Invalid fragment privacy settings" }, { status: 400 });
    }

    const input = body as Record<string, unknown>;
    const validVisibility = ["private", "group", "restricted"].includes(String(input.visibility));
    if (!validVisibility || typeof input.aiProcessingConsent !== "boolean") {
      return Response.json({ error: "Visibility and AI consent must be explicit" }, { status: 400 });
    }

    const database = await getMongoDatabase();
    const repository = new MongoMemoryRepository(database);
    const previous = await repository.findFragmentById(groupId, fragmentId);
    if (
      !previous ||
      previous.deletionState !== "active" ||
      previous.authorUserId !== session.user.id
    ) {
      return Response.json({ error: "Fragment not found" }, { status: 404 });
    }
    if (previous.type === "voice" && !hasApprovedTextSource(previous)) {
      return Response.json({ error: "Review the transcript before changing voice-note privacy settings" }, { status: 409 });
    }
    if (
      input.aiProcessingConsent &&
      (previous.type === "image" || previous.type === "video") &&
      !hasAnalyzableFragmentSource(previous)
    ) {
      return Response.json({ error: "This media source is unavailable for private AI processing" }, { status: 409 });
    }
    const visibility = input.visibility as "private" | "group" | "restricted";
    const aiProcessingConsent = input.aiProcessingConsent;
    if (visibility !== "group" || !aiProcessingConsent) {
      await deleteFragmentBackboardMemories({ database, groupId, fragmentId });
    }
    const analyses = new MongoFragmentAnalysisRepository(database);
    const existingAnalysis = aiProcessingConsent
      ? await analyses.find(groupId, fragmentId, FRAGMENT_ANALYSIS_VERSION)
      : null;
    const ingestion = new MongoIngestionRepository(database);
    const previousJob = await ingestion.findProcessingJob(
      groupId,
      `ingest:${groupId}:${fragmentId}:${previous.processingVersion}`,
    );
    const shouldQueueAnalysis =
      aiProcessingConsent &&
      !existingAnalysis &&
      previousJob?.status !== "queued" &&
      previousJob?.status !== "running" &&
      (previous.aiProcessingConsent !== true || !previousJob || previousJob.status === "succeeded");
    const processingVersion = shouldQueueAnalysis
      ? `${FRAGMENT_ANALYSIS_VERSION}-${Date.now()}`
      : undefined;
    if (shouldQueueAnalysis) await getTemporalClient();

    const fragment = await repository.updateFragmentPrivacy({
      groupId,
      fragmentId,
      authorUserId: session.user.id,
      visibility,
      aiProcessingConsent,
      ...(processingVersion ? { processingVersion } : {}),
    });
    if (!fragment) return Response.json({ error: "Fragment not found" }, { status: 404 });
    if (!fragment.aiProcessingConsent) await analyses.delete(groupId, fragmentId);
    if ((fragment.visibility !== "group" || !fragment.aiProcessingConsent) && process.env.TIGER_DATABASE_URL) {
      await new TigerDataFragmentSearch().removeGroupVisibleFragment(groupId, fragmentId);
    } else if (fragment.visibility === "group" && fragment.aiProcessingConsent && existingAnalysis) {
      await indexEligibleFragmentAnalysis(database, existingAnalysis);
    }

    let processingStatus = fragment.aiProcessingConsent ? previousJob?.status ?? null : null;
    let jobId = fragment.aiProcessingConsent ? previousJob?.id ?? null : null;
    let workflowId = fragment.aiProcessingConsent ? previousJob?.temporalWorkflowId ?? null : null;
    if (shouldQueueAnalysis && processingVersion) {
      const job = await ingestion.upsertProcessingJob({
        groupId,
        fragmentId,
        jobType: "ingest",
        processingVersion,
      });
      jobId = job.id;
      try {
        workflowId = await startFragmentWorkflow(job, "processFragmentWorkflow");
        processingStatus = "queued";
      } catch {
        await ingestion.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
        workflowId = null;
        processingStatus = "failed";
      }
    }
    const { storageUri, ...visibleFragment } = fragment;
    void storageUri;
    return Response.json(
      { fragment: { ...visibleFragment, processingJobStatus: processingStatus }, jobId, workflowId },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TemporalConfigurationError) {
      return Response.json({ error: "Processing is not configured on this server" }, { status: 503 });
    }
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string; fragmentId: string }> },
) {
  try {
    const { groupId, fragmentId } = await context.params;
    const { session, membership } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const repository = new MongoMemoryRepository(database);
    const fragment = await repository.findFragmentById(groupId, fragmentId);
    if (!fragment) return Response.json({ error: "Fragment not found" }, { status: 404 });
    const canManageGroup = membership.role === "owner" || membership.role === "admin";
    if (
      fragment.authorUserId !== session.user.id &&
      !(canManageGroup && fragment.visibility === "group")
    ) {
      return Response.json({ error: "Fragment not found" }, { status: 404 });
    }
    await deleteFragmentBackboardMemories({ database, groupId, fragmentId });
    const managedGroupMedia =
      fragment.source === "upload" &&
      (fragment.type === "image" || fragment.type === "video") &&
      fragment.storageUri !== null &&
      isManagedGroupMediaStorageUri(fragment.storageUri);
    const legacyMediaCleanupRequired =
      fragment.source === "upload" &&
      fragment.type !== "voice" &&
      fragment.storageUri !== null &&
      !managedGroupMedia;
    const requested = fragment.deletionState === "pending" ||
      await repository.requestFragmentDeletion({
        groupId,
        fragmentId,
        actorUserId: session.user.id,
        canManageGroup,
      });
    if (!requested) return Response.json({ error: "Fragment not found" }, { status: 404 });
    if (fragment.type === "voice" && fragment.storageUri) {
      await new MongoVoiceStorage(database).delete(fragment.storageUri);
      await new MongoVoiceRepository(database).deleteTranscript(groupId, fragmentId);
    } else if (managedGroupMedia && fragment.storageUri) {
      await new MongoGroupMediaStorage(database).delete(fragment.storageUri, { groupId, fragmentId });
    }
    if (process.env.TIGER_DATABASE_URL) {
      await new TigerDataFragmentSearch().removeGroupVisibleFragment(groupId, fragmentId);
    }
    await new MongoFragmentAnalysisRepository(database).delete(groupId, fragmentId);
    await new MongoIngestionRepository(database).markFragmentDeletionComplete(groupId, fragmentId);
    return Response.json({ status: "deleted", legacyMediaCleanupRequired }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}