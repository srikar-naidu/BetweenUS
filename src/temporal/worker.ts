import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as Sentry from "@sentry/node";
import * as activities from "./activities";
import { getTemporalSettings } from "@/lib/processing/temporal-client";
import {
  privacySafeSentryOptions,
  sentryIsEnabled,
  type SafeSentryCategory,
} from "@/lib/observability/sentry-privacy";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

type ActivityName = "job-status" | "ingest" | "transcription" | "reconstruction" | "deletion";

const activityFailureCategories: Record<ActivityName, SafeSentryCategory> = {
  "job-status": "temporal_activity_job_status_failure",
  ingest: "temporal_activity_ingest_failure",
  transcription: "temporal_activity_transcription_failure",
  reconstruction: "temporal_activity_reconstruction_failure",
  deletion: "temporal_activity_deletion_failure",
};

function captureSafeFailure(category: SafeSentryCategory): void {
  if (!sentryIsEnabled()) return;
  Sentry.withScope((scope) => {
    scope.setTag("category", category);
    Sentry.captureException(new Error("Temporal operation failed"));
  });
}

function instrumentActivity<Input, Output>(
  name: ActivityName,
  activity: (input: Input) => Promise<Output>,
): (input: Input) => Promise<Output> {
  const category = activityFailureCategories[name];
  return async (input) => Sentry.startSpan(
    { name: `temporal.activity.${name}`, op: "function" },
    async () => {
      try {
        return await activity(input);
      } catch (error) {
        captureSafeFailure(category);
        throw error;
      }
    },
  );
}

const instrumentedActivities = {
  markProcessingJobStarted: instrumentActivity("job-status", activities.markProcessingJobStarted),
  verifyIngestedFragment: instrumentActivity("ingest", activities.verifyIngestedFragment),
  analyzeFragment: instrumentActivity("ingest", activities.analyzeFragment),
  transcribeVoiceNote: instrumentActivity("transcription", activities.transcribeVoiceNote),
  reconstructMomentForFragment: instrumentActivity("reconstruction", activities.reconstructMomentForFragment),
  markProcessingJobSucceeded: instrumentActivity("job-status", activities.markProcessingJobSucceeded),
  markProcessingJobFailed: instrumentActivity("job-status", activities.markProcessingJobFailed),
  deleteStoredFragment: instrumentActivity("deletion", activities.deleteStoredFragment),
};

async function runWorker() {
  if (sentryIsEnabled()) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      ...privacySafeSentryOptions,
    });
  }
  const settings = getTemporalSettings();
  if (!settings) throw new Error("TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE are required to run the worker");

  const connection = await NativeConnection.connect({
    address: settings.address,
    ...(settings.apiKey
      ? { tls: true, apiKey: settings.apiKey }
      : process.env.TEMPORAL_TLS === "true"
        ? { tls: true }
        : {}),
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: settings.namespace,
      taskQueue: settings.taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
      activities: instrumentedActivities,
      shutdownGraceTime: "30 seconds",
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

runWorker().catch(async () => {
  captureSafeFailure("temporal_worker_failure");
  if (sentryIsEnabled()) await Sentry.flush(2_000);
  console.error("Temporal worker stopped (temporal_worker_failure)");
  process.exitCode = 1;
});
