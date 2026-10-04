import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import type { Fragment, Moment, MomentReviewEvent } from "../src/lib/domain/memory";
import { MomentReviewError, reviewMoment } from "../src/lib/pipeline/moment-review";
import {
  MongoMemoryRepository,
  MomentReviewConflictError,
} from "../src/lib/repositories/mongodb-memory-repository";

const timestamp = new Date("2026-10-04T12:00:00Z");

function makeMoment(overrides: Partial<Moment> = {}): Moment {
  return {
    id: "moment-a",
    groupId: "group-a",
    title: "Lunch",
    summary: "Members mention the cafeteria.",
    confidence: 0.7,
    uncertaintyLabel: "possible",
    uncertaintyReason: "Needs review.",
    startAt: timestamp,
    endAt: new Date(timestamp.getTime() + 5 * 60_000),
    status: "candidate",
    evidence: [
      { fragmentId: "fragment-a", relationship: "shared_location" },
      { fragmentId: "fragment-b", relationship: "shared_location" },
    ],
    reconstruction: {
      modelVersion: "gemma-test",
      retrievalVersion: "hybrid-context-v1",
      validationOutcome: "validated",
      contradictions: [],
      missingEvidence: [],
      uncertaintyNotes: [],
      inferenceNotes: [],
    },
    reviewHistory: [],
    corrections: [],
    revision: 0,
    mergedIntoMomentId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function makeFragment(id: string, authorUserId: string): Fragment {
  return {
    id,
    groupId: "group-a",
    authorUserId,
    type: "text",
    storageUri: null,
    caption: null,
    textContent: "We met at the cafeteria after practice.",
    source: "text",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "fragment-analysis-v1",
    capturedAt: timestamp,
    createdAt: timestamp,
    metadata: {},
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: timestamp,
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  };
}

function createRepository(input: {
  moments: Map<string, Moment>;
  fragments?: Fragment[];
  updates?: Array<{ id: string; changes: Record<string, unknown>; event: unknown }>;
  merges?: unknown[];
}) {
  const { moments, fragments = [], updates = [], merges = [] } = input;
  return {
    async findMoment(groupId: string, momentId: string) {
      const moment = moments.get(momentId);
      return moment?.groupId === groupId ? moment : null;
    },
    async findEligibleGroupVisibleFragmentsByIds(groupId: string, ids: readonly string[]) {
      return fragments.filter((fragment) =>
        fragment.groupId === groupId && ids.includes(fragment.id),
      );
    },
    async reviewMoment(review: {
      momentId: string;
      changes: Record<string, unknown>;
      event: unknown;
    }) {
      updates.push({ id: review.momentId, changes: review.changes, event: review.event });
      const current = moments.get(review.momentId);
      if (!current) return false;
      moments.set(review.momentId, {
        ...current,
        ...review.changes,
        updatedAt: (review.event as { occurredAt: Date }).occurredAt,
        reviewHistory: [...(current.reviewHistory ?? []), review.event as MomentReviewEvent],
        revision: (current.revision ?? 0) + 1,
      });
      return true;
    },
    async mergeMoments(merge: unknown) {
      merges.push(merge);
    },
  } as unknown as MongoMemoryRepository;
}

test("member confirmation records an audit event and is the only path to confirmed status", async () => {
  const moment = makeMoment();
  const repository = createRepository({
    moments: new Map([[moment.id, moment]]),
    fragments: [makeFragment("fragment-a", "user-a"), makeFragment("fragment-b", "user-b")],
  });
  const confirmed = await reviewMoment({
    repository,
    groupId: "group-a",
    momentId: moment.id,
    actorUserId: "reviewer",
    review: { action: "confirm" },
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.uncertaintyLabel, "confirmed");
  const event = confirmed.reviewHistory?.[0];
  assert.equal(event?.actorUserId, "reviewer");
  assert.equal(event?.action, "confirm");
  assert.equal(event?.before.status, "candidate");
  assert.equal(event?.after.status, "confirmed");
});

test("confirmation fails when evidence is no longer eligible", async () => {
  const moment = makeMoment();
  const repository = createRepository({
    moments: new Map([[moment.id, moment]]),
    fragments: [makeFragment("fragment-a", "user-a")],
  });
  await assert.rejects(
    reviewMoment({
      repository,
      groupId: "group-a",
      momentId: moment.id,
      actorUserId: "reviewer",
      review: { action: "confirm" },
    }),
    (error: unknown) =>
      error instanceof MomentReviewError &&
      error.status === 409 &&
      /no longer eligible/.test(error.message),
  );
});

test("member corrections and evidence removal remain auditable and downgrade weak evidence", async () => {
  const moment = makeMoment();
  const repository = createRepository({
    moments: new Map([[moment.id, moment]]),
    fragments: [makeFragment("fragment-a", "user-a"), makeFragment("fragment-b", "user-b")],
  });
  const corrected = await reviewMoment({
    repository,
    groupId: "group-a",
    momentId: moment.id,
    actorUserId: "reviewer",
    review: {
      action: "correct",
      correctionType: "place",
      fragmentId: "fragment-a",
      value: "North cafeteria",
    },
  });
  assert.equal(corrected.corrections?.[0].value, "North cafeteria");
  assert.equal(corrected.reviewHistory?.[0].before.corrections.length, 0);
  const downgraded = await reviewMoment({
    repository,
    groupId: "group-a",
    momentId: moment.id,
    actorUserId: "reviewer",
    review: { action: "remove_evidence", fragmentId: "fragment-b" },
  });
  assert.equal(downgraded.status, "draft");
  assert.equal(downgraded.uncertaintyLabel, "unknown");
  assert.deepEqual(downgraded.evidence.map((item) => item.fragmentId), ["fragment-a"]);
  assert.equal(downgraded.reviewHistory?.length, 2);
});

test("a member can reverse the latest correction without erasing its audit trail", async () => {
  const moment = makeMoment();
  const repository = createRepository({
    moments: new Map([[moment.id, moment]]),
    fragments: [makeFragment("fragment-a", "user-a"), makeFragment("fragment-b", "user-b")],
  });
  await reviewMoment({
    repository,
    groupId: "group-a",
    momentId: moment.id,
    actorUserId: "reviewer",
    review: {
      action: "correct",
      correctionType: "person",
      fragmentId: "fragment-a",
      value: "Sam",
    },
  });
  const undone = await reviewMoment({
    repository,
    groupId: "group-a",
    momentId: moment.id,
    actorUserId: "reviewer",
    review: { action: "undo_correction" },
  });

  assert.deepEqual(undone.corrections, []);
  assert.equal(undone.reviewHistory?.length, 2);
  assert.equal(undone.reviewHistory?.[1].action, "undo_correction");
  assert.equal(undone.reviewHistory?.[1].before.corrections.length, 1);
  assert.equal(undone.reviewHistory?.[1].after.corrections.length, 0);
});

test("merging candidates records the request and delegates a transactional merge", async () => {
  const source = makeMoment({ id: "source" });
  const target = makeMoment({
    id: "target",
    evidence: [{ fragmentId: "fragment-c", relationship: "temporal" }],
  });
  const merges: unknown[] = [];
  const repository = createRepository({
    moments: new Map([[source.id, source], [target.id, target]]),
    fragments: [
      makeFragment("fragment-a", "user-a"),
      makeFragment("fragment-b", "user-b"),
      makeFragment("fragment-c", "user-c"),
    ],
    merges,
  });
  const merged = await reviewMoment({
    repository,
    groupId: "group-a",
    momentId: source.id,
    actorUserId: "reviewer",
    review: { action: "merge", targetMomentId: target.id },
  });

  assert.equal(merged.id, target.id);
  assert.equal(merges.length, 1);
  assert.equal((merges[0] as { sourceId: string }).sourceId, source.id);
  assert.equal((merges[0] as { targetId: string }).targetId, target.id);
});

test("Mongo merge uses a transaction and fails if either revision changed", async () => {
  const session = {
    withTransaction: async (operation: () => Promise<void>) => operation(),
    endSession: async () => undefined,
  };
  const updates: Array<{ filter: Record<string, unknown>; options: Record<string, unknown> }> = [];
  let modifiedCount = 1;
  const repository = new MongoMemoryRepository({
    client: { startSession: () => session },
    collection: () => ({
      updateOne: async (
        filter: Record<string, unknown>,
        _update: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        updates.push({ filter, options });
        return { modifiedCount };
      },
    }),
  } as unknown as Db);
  const before = makeMoment();
  const event = before.reviewHistory?.[0] ?? {
    id: "review-event",
    actorUserId: "reviewer",
    action: "merge" as const,
    occurredAt: timestamp,
    before: {
      title: before.title,
      summary: before.summary,
      status: before.status,
      uncertaintyLabel: before.uncertaintyLabel,
      uncertaintyReason: before.uncertaintyReason,
      evidence: before.evidence,
      corrections: [],
      mergedIntoMomentId: null,
    },
    after: {
      title: before.title,
      summary: before.summary,
      status: "merged" as const,
      uncertaintyLabel: "unknown" as const,
      uncertaintyReason: "Merged",
      evidence: before.evidence,
      corrections: [],
      mergedIntoMomentId: "target",
    },
  };
  const input = {
    groupId: "group-a",
    sourceId: "source",
    targetId: "target",
    sourceUpdatedAt: timestamp,
    targetUpdatedAt: timestamp,
    sourceRevision: 0,
    targetRevision: 0,
    sourceChanges: { status: "merged" as const },
    targetChanges: { status: "candidate" as const },
    sourceEvent: event,
    targetEvent: { ...event, id: "target-event" },
  };

  await repository.mergeMoments(input);
  assert.equal(updates.length, 2);
  assert.ok(updates.every((update) => update.options.session === session));
  assert.ok(updates.every((update) => update.filter.groupId === "group-a"));

  updates.length = 0;
  modifiedCount = 0;
  await assert.rejects(repository.mergeMoments(input), MomentReviewConflictError);
});
