import * as Sentry from "@sentry/nextjs";
import {
  privacySafeSentryOptions,
  sentryIsEnabled,
} from "./src/lib/observability/sentry-privacy";

if (sentryIsEnabled()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    ...privacySafeSentryOptions,
  });
}
