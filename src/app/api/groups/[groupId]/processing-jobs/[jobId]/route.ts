import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { momentForGroupMember, visibleMomentsForMember } from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { getTemporalClient, startFragmentWorkflow, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import { hasAnalyzableFragmentSource } from "@/lib/domain/memory";
import { FRAGMENT_ANALYSIS_VERSION, fragmentAnalysisForMember, fragmentSourceDigest } from "@/lib/ai/fragment-analysis";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { safeProcessingFailureCategory } from "@/lib/processing/failure-category";

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
      (fragment.visibility !== "group" && fragment.authorUserId !== session.user.id) ||
      (job.jobType === "reconstruct_moment" &&
        (!hasAnalyzableFragmentSource(fragment) ||
          fragment.visibility !== "group" ||
          !fragment.aiProcessingConsent ||
          !["processed", "needs_review"].includes(fragment.status)))
    ) {
      return Response.json({ error: "Processing job not found" }, { status: 404 });
    }
    if (job.jobType === "ingest" && !fragment.aiProcessingConsent) {
      return Response.json(
        { status: null },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (job.jobType === "ingest" && job.status === "succeeded") {
      const analysis = await new MongoFragmentAnalysisRepository(database).find(
        groupId,
        fragment.id,
        FRAGMENT_ANALYSIS_VERSION,
      );
      return Response.json({
        status: job.status,
        fragmentStatus: fragment.status,
        attemptCount: job.attemptCount,
        updatedAt: job.updatedAt,
        ...(analysis && analysis.sourceContentSha256 === fragmentSourceDigest(fragment)
          ? { analysis: fragmentAnalysisForMember(analysis) }
          : {}),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (job.jobType === "reconstruct_moment" && job.status === "succeeded" && job.outputRef) {
      const moment = await new MongoMemoryRepository(database).findMoment(groupId, job.outputRef);
      if (!moment) return Response.json({ error: "Reconstruction result is unavailable" }, { status: 409 });
      if (moment.reconstruction?.validationOutcome === "insufficient_evidence") {
        return Response.json({
          status: job.status,
          outcome: "insufficient_evidence",
          reason: moment.uncertaintyReason,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const visibleFragments = await new MongoMemoryRepository(database)
        .findMemberVisibleFragments(groupId, session.user.id, 1000);
      const [visibleMoment] = visibleMomentsForMember([moment], visibleFragments);
      return Response.json({
        status: job.status,
        outcome: visibleMoment ? "candidate" : "insufficient_evidence",
        ...(visibleMoment
          ? { moment: momentForGroupMember(visibleMoment) }
          : { reason: "The reconstruction result is no longer available for group review." }),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({
      status: job.status,
      fragmentStatus: fragment.status,
      attemptCount: job.attemptCount,
      updatedAt: job.updatedAt,
      ...(job.status === "failed" && job.errorMessage
        ? { errorCategory: safeProcessingFailureCategory(job.errorMessage) }
        : {}),
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
    if (job.jobType === "reconstruct_moment") {
      return Response.json(
        { error: "Start a new reconstruction request to retry this job" },
        { status: 410 },
      );
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
        fragment.authorUserId !== session.user.id) ||
      (job.jobType === "transcribe_voice" &&
        fragment.authorUserId !== session.user.id)
    ) {
      return Response.json({ error: "A failed processing job was not found" }, { status: 404 });
    }
    if (job.jobType === "transcribe_voice") {
      return Response.json(
        { error: "Automatic retries are disabled to prevent duplicate transcription charges. Enter the transcript manually." },
        { status: 410 },
      );
    }
    if (job.jobType === "ingest" && (
      !hasAnalyzableFragmentSource(fragment) ||
      !fragment.aiProcessingConsent
    )) {
      return Response.json({ error: "Fragment is not eligible for AI processing" }, { status: 410 });
    }
    if (
      job.jobType === "delete_fragment" &&
      fragment.source === "upload" &&
      fragment.type !== "voice" &&
      fragment.storageUri
    ) {
      return Response.json({
        error: "Remove the legacy media object manually before retrying fragment cleanup",
      }, { status: 410 });
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
    return apiErrorResponse(error);
  }
}
