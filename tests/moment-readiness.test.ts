import assert from "node:assert/strict";
import test from "node:test";
import type { Fragment } from "../src/lib/domain/memory";
import { momentReconstructionReadyFragments } from "../src/lib/pipeline/moment-readiness";

function textFragment(input: {
  id: string;
  authorUserId: string;
  minutes: number;
  visibility?: Fragment["visibility"];
  status?: Fragment["status"];
}): Fragment {
  const capturedAt = new Date(Date.parse("2026-10-04T12:00:00Z") + input.minutes * 60_000);
  return {
    id: input.id,
    groupId: "group-a",
    authorUserId: input.authorUserId,
    type: "text",
    storageUri: null,
    caption: null,
    textContent: "We met after practice.",
    source: "text",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "v1",
    capturedAt,
    createdAt: capturedAt,
    metadata: {},
    visibility: input.visibility ?? "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: capturedAt,
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: input.status ?? "processed",
  };
}

test("Moment reconstruction is available for nearby analyzed posts from different members", () => {
  const fragments = [
    textFragment({ id: "one", authorUserId: "author-one", minutes: 0 }),
    textFragment({ id: "two", authorUserId: "author-two", minutes: 18 }),
  ];
  assert.deepEqual(
    momentReconstructionReadyFragments(fragments).map((fragment) => fragment.id),
    ["one", "two"],
  );
});

test("Moment reconstruction waits for an independent contributor and eligible sources", () => {
  assert.deepEqual(momentReconstructionReadyFragments([
    textFragment({ id: "one", authorUserId: "author-one", minutes: 0 }),
    textFragment({ id: "same-author", authorUserId: "author-one", minutes: 1 }),
    textFragment({ id: "too-late", authorUserId: "author-two", minutes: 22 }),
    textFragment({ id: "private", authorUserId: "author-two", minutes: 0, visibility: "private" }),
    textFragment({ id: "pending", authorUserId: "author-two", minutes: 0, status: "processing" }),
  ]), []);
});
