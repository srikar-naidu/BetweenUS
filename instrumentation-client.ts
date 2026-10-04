import * as Sentry from "@sentry/nextjs";
import {
  privacySafeSentryOptions,
} from "./src/lib/observability/sentry-privacy";

if (
  process.env.NEXT_PUBLIC_SENTRY_ENABLED === "true" &&
  process.env.NEXT_PUBLIC_SENTRY_DSN
) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    ...privacySafeSentryOptions,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}
