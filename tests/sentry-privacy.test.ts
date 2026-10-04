import assert from "node:assert/strict";
import test from "node:test";
import type { ErrorEvent, NodeOptions } from "@sentry/node";
import {
  sanitizeSentryEvent,
  sanitizeSentrySpan,
  sentryIsEnabled,
} from "../src/lib/observability/sentry-privacy";

type SentrySpan = Parameters<NonNullable<NodeOptions["beforeSendSpan"]>>[0];

test("Sentry error events retain only generic errors and approved categories", () => {
  const unsafeEvent: ErrorEvent = {
    type: undefined,
    message: "A private fragment was processed with prompt text",
    request: {
      url: "https://example.test/groups/private-group?token=private-token",
      headers: { authorization: "private-token" },
      data: { prompt: "private memory", audio: "private media" },
    },
    user: { id: "private-user" },
    extra: { providerResponse: "private provider response" },
    contexts: { application: { content: "private fragment" } },
    breadcrumbs: [{ message: "private breadcrumb" }],
    tags: { category: "temporal_activity_ingest_failure", user: "private-user" },
    exception: { values: [{ type: "Error", value: "provider response includes private data" }] },
  };

  const safeEvent = sanitizeSentryEvent(unsafeEvent);
  assert.deepEqual(safeEvent.tags, { category: "temporal_activity_ingest_failure" });
  assert.deepEqual(safeEvent.exception?.values, [{
    type: "ApplicationError",
    value: "An application operation failed",
  }]);
  assert.equal("request" in safeEvent, false);
  assert.equal("user" in safeEvent, false);
  assert.equal("extra" in safeEvent, false);
  assert.equal("contexts" in safeEvent, false);
  assert.equal("breadcrumbs" in safeEvent, false);
  assert.equal("message" in safeEvent, false);
});

test("Sentry spans keep duration and opaque trace IDs but discard names and attributes", () => {
  const unsafeSpan: SentrySpan = {
    trace_id: "opaque-trace",
    span_id: "opaque-span",
    name: "/groups/private-group/fragments/private-fragment",
    start_timestamp: 1,
    end_timestamp: 2,
    status: "error",
    is_segment: true,
    attributes: {
      "http.url": "https://example.test/private?token=secret",
      "gen_ai.prompt": "private fragment",
    },
    links: [],
  };

  const safeSpan = sanitizeSentrySpan(unsafeSpan);
  assert.equal(safeSpan.name, "operation");
  assert.deepEqual(safeSpan.attributes, {});
  assert.deepEqual(safeSpan.links, []);
  assert.equal(safeSpan.start_timestamp, 1);
  assert.equal(safeSpan.end_timestamp, 2);
});

test("Sentry remains disabled unless explicitly enabled with a DSN", () => {
  assert.equal(sentryIsEnabled({ SENTRY_ENABLED: "true", SENTRY_DSN: "https://public@example.test/1" }), true);
  assert.equal(sentryIsEnabled({ SENTRY_ENABLED: "false", SENTRY_DSN: "https://public@example.test/1" }), false);
  assert.equal(sentryIsEnabled({ SENTRY_ENABLED: "true", SENTRY_DSN: "" }), false);
});
