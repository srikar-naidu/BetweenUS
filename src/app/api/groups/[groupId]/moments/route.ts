import { apiErrorResponse } from "@/lib/api/errors";
import { createHash } from "node:crypto";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { momentForGroupMember, visibleMomentsForMember } from "@/lib/auth/group-visibility";
import { FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MOMENT_RECONSTRUCTION_VERSION } from "@/lib/pipeline/moment-reconstruction";
import { TemporalConfigurationError, getTemporalClient, startMomentReconstructionWorkflow } from "@/lib/processing/temporal-client";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { hasApprovedTextSource } from "@/lib/domain/memory";

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
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).anchorFragmentId !== "string" ||
      !(body as Record<string, unknown>).anchorFragmentId ||
      ((body as { anchorFragmentId: string }).anchorFragmentId.length > 128)
    ) {
      return Response.json({ error: "An anchor fragment ID is required" }, { status: 400 });
    }
    const requestId = request.headers.get("Idempotency-Key");
    if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      return Response.json({ error: "A UUID Idempotency-Key is required" }, { status: 400 });
    }
    const anchorFragmentId = (body as { anchorFragmentId: string }).anchorFragmentId;
    const database = await getMongoDatabase();
    const memory = new MongoMemoryRepository(database);
    const anchor = await memory.findFragmentVisibleToMember(groupId, anchorFragmentId, session.user.id);
    if (
      !anchor ||
      !hasApprovedTextSource(anchor) ||
      anchor.visibility !== "group" ||
      !anchor.aiProcessingConsent ||
      anchor.deletionState !== "active" ||
      anchor.status !== "processed"
    ) {
      return Response.json({ error: "Eligible anchor fragment not found" }, { status: 404 });
    }
    const analysis = await new MongoFragmentAnalysisRepository(database).find(
      groupId,
      anchor.id,
      FRAGMENT_ANALYSIS_VERSION,
    );
    if (!analysis) {
      return Response.json({ error: "Anchor fragment analysis is not ready" }, { status: 409 });
    }
    await getTemporalClient();
    const processingVersion = `${MOMENT_RECONSTRUCTION_VERSION}-${createHash("sha256")
      .update(`${session.user.id}\0${requestId}`)
      .digest("hex")}`;
    const jobs = new MongoIngestionRepository(database);
    const job = await jobs.upsertProcessingJob({
      groupId,
      fragmentId: anchor.id,
      jobType: "reconstruct_moment",
      processingVersion,
    });
    if (job.status !== "queued") {
      return Response.json({
        jobId: job.id,
        workflowId: job.temporalWorkflowId,
        status: job.status,
      }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    let workflowId: string;
    try {
      workflowId = await startMomentReconstructionWorkflow(job, session.user.id);
    } catch {
      await jobs.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
      return Response.json({ error: "Moment reconstruction could not be queued" }, { status: 503 });
    }
    return Response.json(
      { jobId: job.id, workflowId, status: "queued" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TemporalConfigurationError) {
      return Response.json({ error: "Processing is not configured on this server" }, { status: 503 });
    }
    return apiErrorResponse(error);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const repository = new MongoMemoryRepository(await getMongoDatabase());
    const [moments, fragments] = await Promise.all([
      repository.listMoments(groupId),
      repository.findMemberVisibleFragments(groupId, session.user.id, 1000),
    ]);
    const visibleMoments = visibleMomentsForMember(moments, fragments);
    const publicMoments = visibleMoments.map(momentForGroupMember);

    return Response.json(
      { moments: publicMoments },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}