import nextEnv from "@next/env";
import * as Sentry from "@sentry/node";
import { getMongoClient, getMongoDatabase } from "@/lib/db/mongodb";
import { runMongoBackgroundWorker, safeWorkerError } from "@/lib/processing/mongodb-background-worker";
import {
  privacySafeSentryOptions,
  sentryIsEnabled,
} from "@/lib/observability/sentry-privacy";

nextEnv.loadEnvConfig(process.cwd());

if (sentryIsEnabled()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    ...privacySafeSentryOptions,
  });
}

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
let mongoInitialized = false;

async function main(): Promise<void> {
  const database = await getMongoDatabase();
  mongoInitialized = true;
  await runMongoBackgroundWorker({
    database,
    signal: shutdown.signal,
    onJobError: () => {
      if (!sentryIsEnabled()) return;
      Sentry.withScope((scope) => {
        scope.setTag("category", "processing_worker_failure");
        Sentry.captureException(safeWorkerError());
      });
    },
  });
}

main().catch(async () => {
  if (sentryIsEnabled()) {
    Sentry.withScope((scope) => {
      scope.setTag("category", "processing_worker_failure");
      Sentry.captureException(safeWorkerError());
    });
    await Sentry.flush(2_000);
  }
  console.error("MongoDB background worker stopped (processing_worker_failure)");
  process.exitCode = 1;
}).finally(async () => {
  if (mongoInitialized) await getMongoClient().close();
});
