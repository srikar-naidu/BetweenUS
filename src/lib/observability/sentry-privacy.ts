import type { ErrorEvent, NodeOptions } from "@sentry/node";

type SentrySpan = Parameters<NonNullable<NodeOptions["beforeSendSpan"]>>[0];

export const SAFE_SENTRY_CATEGORIES = [
  "application_error",
  "next_request_failure",
  "temporal_worker_failure",
  "temporal_activity_job_status_failure",
  "temporal_activity_ingest_failure",
  "temporal_activity_transcription_failure",
  "temporal_activity_reconstruction_failure",
  "temporal_activity_deletion_failure",
] as const;

export type SafeSentryCategory = (typeof SAFE_SENTRY_CATEGORIES)[number];

const safeSpanNames = new Set([
  "operation",
  "temporal.activity.job-status",
  "temporal.activity.ingest",
  "temporal.activity.transcription",
  "temporal.activity.reconstruction",
  "temporal.activity.deletion",
]);

export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent {
  const category = SAFE_SENTRY_CATEGORIES.find(
    (item) => item === event.tags?.category,
  ) ?? "application_error";
  const level = event.level === "fatal" || event.level === "warning" ||
      event.level === "info" || event.level === "debug"
    ? event.level
    : "error";
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    type: undefined,
    platform: "javascript",
    level,
    environment: event.environment,
    release: event.release,
    tags: { category },
    exception: {
      values: [{ type: "ApplicationError", value: "An application operation failed" }],
    },
  };
}

export function sanitizeSentrySpan(span: SentrySpan): SentrySpan {
  return {
    ...span,
    name: safeSpanNames.has(span.name) ? span.name : "operation",
    attributes: {},
    links: [],
  };
}

export const privacySafeSentryOptions = {
  sendDefaultPii: false,
  maxBreadcrumbs: 0,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  },
  tracesSampleRate: 0.02,
  beforeSend: sanitizeSentryEvent,
  beforeSendSpan: sanitizeSentrySpan,
};

export function sentryIsEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.SENTRY_ENABLED === "true" &&
    typeof environment.SENTRY_DSN === "string" &&
    environment.SENTRY_DSN.length > 0;
}
