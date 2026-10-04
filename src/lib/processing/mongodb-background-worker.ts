import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import type { Db } from "mongodb";
import * as activities from "@/lib/processing/pipeline-activities";
import {
  MongoBackgroundJobQueue,
  type ClaimedBackgroundJob,
} from "@/lib/processing/mongodb-background-job-queue";
import {
  sentryIsEnabled,
} from "@/lib/observability/sentry-privacy";

const POLL_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 60_000;

function categoryForError(error: unknown, fallback: string): string {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth += 1) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const detail = current as Record<string, unknown>;
    const descriptor = `${detail.name ?? ""} ${detail.type ?? ""} ${detail.message ?? ""}`.toLowerCase();
    if (descriptor.includes("could not reach the configured gemma runtime") ||
        (descriptor.includes("gemmaprovidererror") && descriptor.includes("ollama returned http"))) {
      return "gemma_runtime_unavailable";
    }
    if (descriptor.includes("fragmentanalysisvalidationerror") ||
        descriptor.includes("ollama response has no message content") ||
        descriptor.includes("ollama message content is not valid json")) {
      return "gemma_output_invalid";
    }
    if (
      descriptor.includes("fragmentunavailable") ||
      descriptor.includes("unsupportedfragmenttype") ||
      descriptor.includes("fragmentconsentrevoked") ||
      descriptor.includes("mediasourceunavailable") ||
      descriptor.includes("mediasourcechanged") ||
      descriptor.includes("fragmentelegibilitychanged")
    ) {
      return "fragment_source_unavailable";
    }
    if ("cause" in detail) pending.push(detail.cause);
  }
  return fallback;
}

function captureJobFailure(collection: string, category: string): void {
  console.error(`Background ${collection} job failed (${category})`);
  if (!sentryIsEnabled()) return;
  Sentry.withScope((scope) => {
    scope.setTag("category", "processing_job_failure");
    scope.setTag("job_collection", collection);
    scope.setTag("failure_category", category);
    Sentry.captureException(new Error("Background processing job failed"));
  });
}

async function processFragmentJob(job: ClaimedBackgroundJob, executionId: string): Promise<void> {
  const groupId = job.groupId;
  const fragmentId = job.fragmentId;
  try {
    if (!job.jobType || !fragmentId) throw new Error("Invalid processing job payload");
    if (job.jobType === "ingest" || job.jobType === "transcribe_voice") {
      await activities.markProcessingJobStarted({
        jobId: job.id,
        workflowId: executionId,
        groupId,
        fragmentId,
        fragmentStatus: "processing",
      });
    }

    switch (job.jobType) {
      case "ingest": {
        await activities.verifyIngestedFragment({ groupId, fragmentId });
        const analysis = await activities.analyzeFragment({ groupId, fragmentId });
        await activities.markProcessingJobSucceeded({
          jobId: job.id,
          outputRef: analysis?.analysisId ?? fragmentId,
          groupId,
          fragmentId,
          fragmentStatus: analysis?.requiresReview ? "needs_review" : "processed",
        });
        break;
      }
      case "transcribe_voice":
        await activities.transcribeVoiceNote({ groupId, fragmentId });
        await activities.markProcessingJobSucceeded({
          jobId: job.id,
          outputRef: fragmentId,
          groupId,
          fragmentId,
          fragmentStatus: "processed",
        });
        break;
      case "delete_fragment":
        await activities.deleteStoredFragment({ groupId, fragmentId });
        await activities.markProcessingJobSucceeded({ jobId: job.id, outputRef: fragmentId });
        break;
      case "reconstruct_moment": {
        if (!job.requesterUserId) throw new Error("Moment reconstruction requester is unavailable");
        const momentId = await activities.reconstructMomentForFragment({
          groupId,
          fragmentId,
          requesterUserId: job.requesterUserId,
          momentId: job.id,
        });
        await activities.markProcessingJobSucceeded({ jobId: job.id, outputRef: momentId });
        break;
      }
    }
  } catch (error) {
    const category = job.jobType === "transcribe_voice"
      ? "voice_transcription_failed"
      : job.jobType === "ingest"
        ? categoryForError(error, "fragment_ingestion_failed")
        : job.jobType === "delete_fragment"
          ? "fragment_deletion_failed"
          : "moment_reconstruction_failed";
    if (job.jobType === "transcribe_voice") {
      await activities.markProcessingJobFailed({
        jobId: job.id,
        errorCategory: category,
        groupId,
        fragmentId,
        fragmentStatus: "rejected",
      });
    } else {
      await activities.markProcessingJobFailed({
        jobId: job.id,
        errorCategory: category,
        ...(job.jobType === "ingest" && fragmentId
          ? { groupId, fragmentId, fragmentStatus: "rejected" as const }
          : {}),
      });
    }
    captureJobFailure(job.collection, category);
  }
}

async function processStoryJob(job: ClaimedBackgroundJob, executionId: string): Promise<void> {
  try {
    if (!job.requesterUserId) throw new Error("Story requester is unavailable");
    await activities.markStoryJobStarted({
      jobId: job.id,
      groupId: job.groupId,
      workflowId: executionId,
    });
    const result = await activities.reconstructStoryForGroup({
      groupId: job.groupId,
      requesterUserId: job.requesterUserId,
      storyId: `story-${job.id}`,
    });
    await activities.markStoryJobSucceeded({
      jobId: job.id,
      groupId: job.groupId,
      storyId: result.storyId,
      outcome: result.outcome,
    });
  } catch {
    await activities.markStoryJobFailed({
      jobId: job.id,
      groupId: job.groupId,
      errorCategory: "story_reconstruction_failed",
    });
    captureJobFailure(job.collection, "story_reconstruction_failed");
  }
}

async function processEventStoryJob(job: ClaimedBackgroundJob, executionId: string): Promise<void> {
  try {
    await activities.markEventStoryGenerationRunning({
      jobId: job.id,
      workflowId: executionId,
    });
    await activities.generateEventStoryForGroup({ jobId: job.id });
  } catch {
    await activities.markEventStoryGenerationFailed({
      jobId: job.id,
      errorCategory: "event_story_generation_failed",
    });
    captureJobFailure(job.collection, "event_story_generation_failed");
  }
}

async function processJob(job: ClaimedBackgroundJob): Promise<void> {
  const executionId = `mongodb-worker:${job.workerLeaseId}`;
  try {
    switch (job.collection) {
      case "processing_jobs":
        await processFragmentJob(job, executionId);
        break;
      case "story_reconstruction_jobs":
        await processStoryJob(job, executionId);
        break;
      case "event_story_generation_jobs":
        await processEventStoryJob(job, executionId);
        break;
    }
  } catch (error) {
    if (job.collection === "processing_jobs") {
      await activities.markProcessingJobFailed({
        jobId: job.id,
        errorCategory: "background_worker_failed",
      });
    } else if (job.collection === "story_reconstruction_jobs") {
      await activities.markStoryJobFailed({
        jobId: job.id,
        groupId: job.groupId,
        errorCategory: "background_worker_failed",
      });
    } else {
      await activities.markEventStoryGenerationFailed({
        jobId: job.id,
        errorCategory: "background_worker_failed",
      });
    }
    captureJobFailure(job.collection, "background_worker_failed");
    throw error;
  }
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, POLL_INTERVAL_MS);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runMongoBackgroundWorker(input: {
  database: Db;
  signal: AbortSignal;
  workerId?: string;
  onJobError?: (error: unknown) => void;
}): Promise<void> {
  const queue = new MongoBackgroundJobQueue(input.database);
  const workerId = input.workerId ?? `between-us-${randomUUID()}`;
  await queue.ensureIndexes();

  while (!input.signal.aborted) {
    const job = await queue.claimNext(workerId);
    if (!job) {
      await waitForNextPoll(input.signal);
      continue;
    }

    const heartbeat = setInterval(() => {
      void queue.extendLease(job).then((extended) => {
        if (!extended) input.onJobError?.(new Error("Background job lease was lost"));
      }).catch((error: unknown) => input.onJobError?.(error));
    }, HEARTBEAT_INTERVAL_MS);
    try {
      await processJob(job);
    } catch (error) {
      input.onJobError?.(error);
    } finally {
      clearInterval(heartbeat);
      await queue.release(job);
    }
  }
}

export function safeWorkerError(): Error {
  return new Error("MongoDB background worker operation failed");
}
