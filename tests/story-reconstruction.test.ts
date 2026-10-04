import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { fragmentSourceDigest } from "../src/lib/ai/fragment-analysis";
import type { Fragment, Moment, Story } from "../src/lib/domain/memory";
import { storyForGroupMember, visibleStoriesForMember } from "../src/lib/auth/group-visibility";
import {
  buildStoryContextPacket,
  deriveStoryContextKey,
  deriveStorySourceKey,
  reconstructStoryConnection,
  storyConnectionResponseSchema,
  validateStoryConnectionOutput,
  type StoryContextPacket,
} from "../src/lib/pipeline/story-reconstruction";
import { MongoStoryRepository } from "../src/lib/repositories/mongodb-story-repository";

const time = new Date("2026-10-04T12:00:00.000Z");

function fragment(input: {
  id: string;
  groupId?: string;
  visibility?: Fragment["visibility"];
}): Fragment {
  return {
    id: input.id,
    groupId: input.groupId ?? "group-a",
    authorUserId: `author-${input.id}`,
    type: "text",
    storageUri: null,
    caption: null,
    textContent: `private source text for ${input.id}`,
    source: "text",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "test-v1",
    capturedAt: time,
    createdAt: time,
    metadata: {},
    visibility: input.visibility ?? "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: time,
    aiProcessingConsentRevokedAt: null,
    transcriptionConsent: false,
    transcriptionConsentAt: null,
    transcriptionConsentRevokedAt: null,
    transcriptReviewedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  };
}

function moment(input: {
  id: string;
  fragments: string[];
  groupId?: string;
  status?: Moment["status"];
  offsetDays?: number;
}): Moment {
  const startAt = new Date(time.getTime() + (input.offsetDays ?? 0) * 24 * 60 * 60_000);
  return {
    id: input.id,
    groupId: input.groupId ?? "group-a",
    title: "Coffee at Bluebird Cafe",
    summary: "The group met at Bluebird Cafe for coffee.",
    confidence: 0.9,
    uncertaintyLabel: "confirmed",
    uncertaintyReason: "A group member confirmed this moment.",
    startAt,
    endAt: new Date(startAt.getTime() + 30 * 60_000),
    status: input.status ?? "confirmed",
    evidence: input.fragments.map((fragmentId) => ({
      fragmentId,
      relationship: "shared_location" as const,
    })),
    reviewHistory: [],
    corrections: [],
    revision: 1,
    mergedIntoMomentId: null,
    createdAt: time,
    updatedAt: time,
  };
}

function packet(): StoryContextPacket {
  return {
    version: "story-context-v1",
    moments: [
      {
        moment_id: "moment-1",
        moment_revision: 1,
        start_at: time.toISOString(),
        end_at: new Date(time.getTime() + 30 * 60_000).toISOString(),
        title: "Coffee at Bluebird Cafe",
        summary: "The group met at Bluebird Cafe for coffee.",
        source_fragments: [{
          fragment_id: "fragment-1",
          facts: [{ type: "place", value: "Bluebird Cafe", modality: "text" }],
          entities: ["Bluebird Cafe", "coffee"],
        }],
      },
      {
        moment_id: "moment-2",
        moment_revision: 1,
        start_at: new Date(time.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
        end_at: new Date(time.getTime() + 7 * 24 * 60 * 60_000 + 30 * 60_000).toISOString(),
        title: "Coffee at Bluebird again",
        summary: "The group returned to Bluebird Cafe for coffee.",
        source_fragments: [{
          fragment_id: "fragment-2",
          facts: [{ type: "place", value: "Bluebird Cafe", modality: "voice_transcript" }],
          entities: ["Bluebird Cafe", "coffee"],
        }],
      },
    ],
  };
}

const validConnection = {
  title: "Coffee at Bluebird",
  summary: "The group returned to the same cafe for coffee.",
  confidence: 0.86,
  evidence: [
    { moment_id: "moment-1", relationship: "same_location" },
    { moment_id: "moment-2", relationship: "same_location" },
  ],
};

function story(input: Partial<Story> = {}): Story {
  return {
    id: "story-1",
    groupId: "group-a",
    title: "Coffee at Bluebird",
    summary: "The group returned to the same cafe for coffee.",
    confidence: 0.86,
    uncertaintyLabel: "possible",
    uncertaintyReason: "The pattern has not been confirmed by group members.",
    startAt: time,
    endAt: new Date(time.getTime() + 7 * 24 * 60 * 60_000),
    momentIds: ["moment-1", "moment-2"],
    evidence: [
      {
        momentId: "moment-1",
        momentRevision: 1,
        relationship: "same_location",
        fragmentIds: ["fragment-1"],
        fragmentSourceDigests: [{
          fragmentId: "fragment-1",
          sourceContentSha256: fragmentSourceDigest(fragment({ id: "fragment-1" })),
        }],
      },
      {
        momentId: "moment-2",
        momentRevision: 1,
        relationship: "same_location",
        fragmentIds: ["fragment-2"],
        fragmentSourceDigests: [{
          fragmentId: "fragment-2",
          sourceContentSha256: fragmentSourceDigest(fragment({ id: "fragment-2" })),
        }],
      },
    ],
    status: "candidate",
    modelVersion: "gemma4:e2b",
    sourceKey: deriveStorySourceKey([
      moment({ id: "moment-1", fragments: ["fragment-1"] }),
      moment({ id: "moment-2", fragments: ["fragment-2"], offsetDays: 7 }),
    ]),
    reconstructionVersion: "story-reconstruction-v1",
    contextKey: "context-key",
    reviewHistory: [],
    revision: 0,
    createdAt: time,
    updatedAt: time,
    ...input,
  };
}

test("StoryConnection schema and validator accept only evidence-backed confirmed Moments", () => {
  const context = packet();
  const schema = storyConnectionResponseSchema(context) as {
    properties: { evidence: { items: { properties: { moment_id: { enum: string[] } } } } };
  };
  assert.deepEqual(schema.properties.evidence.items.properties.moment_id.enum, [
    "moment-1",
    "moment-2",
  ]);

  const proposal = validateStoryConnectionOutput(validConnection, context);
  assert.equal(proposal?.title, validConnection.title);
  assert.deepEqual(proposal?.evidence.map((item) => item.momentId), ["moment-1", "moment-2"]);
  assert.equal(
    validateStoryConnectionOutput({
      title: null,
      summary: null,
      confidence: 0,
      evidence: [],
    }, context),
    null,
  );
});

test("StoryConnection rejects foreign Moments and unsupported relationships", () => {
  const context = packet();
  assert.throws(
    () => validateStoryConnectionOutput({
      ...validConnection,
      evidence: [
        { moment_id: "moment-1", relationship: "same_location" },
        { moment_id: "foreign-moment", relationship: "same_location" },
      ],
    }, context),
    /outside the authorized Story context/,
  );
  assert.throws(
    () => validateStoryConnectionOutput({
      ...validConnection,
      evidence: [
        { moment_id: "moment-1", relationship: "shared_people" },
        { moment_id: "moment-2", relationship: "shared_people" },
      ],
    }, context),
    /unsupported shared_people evidence/,
  );
  assert.throws(
    () => validateStoryConnectionOutput({
      ...validConnection,
      evidence: [{ moment_id: "moment-1", relationship: "made_up" }],
    }, context),
    /invalid Story evidence/,
  );
  assert.throws(
    () => validateStoryConnectionOutput({
      ...validConnection,
      summary: "A free-form unsupported story.",
      evidence: [],
    }, context),
    /without at least two cited Moments/,
  );
});

test("Story ContextPacket excludes unconfirmed, foreign, private, and stale source evidence", () => {
  const sourceA = fragment({ id: "fragment-a" });
  const sourceB = fragment({ id: "fragment-b" });
  const privateSource = fragment({ id: "private-fragment", visibility: "private" });
  const foreignSource = fragment({ id: "foreign-fragment", groupId: "group-b" });
  const observations = [sourceA, sourceB, privateSource, foreignSource].map((source) => ({
    groupId: source.groupId,
    fragmentId: source.id,
    sourceContentSha256: fragmentSourceDigest(source),
    observedFacts: [{
      type: "place",
      value: "Bluebird Cafe",
      evidence: { modality: "text" },
    }],
    entities: ["Bluebird Cafe"],
  }));
  const result = buildStoryContextPacket({
    groupId: "group-a",
    moments: [
      moment({ id: "moment-a", fragments: ["fragment-a", "fragment-b"] }),
      moment({ id: "moment-unconfirmed", fragments: ["fragment-a"], status: "candidate" }),
      moment({ id: "moment-private", fragments: ["private-fragment"] }),
      moment({ id: "moment-foreign", fragments: ["foreign-fragment"], groupId: "group-b" }),
    ],
    fragments: [sourceA, sourceB, privateSource, foreignSource],
    analyses: observations,
  });

  assert.deepEqual(result.moments.map((item) => item.moment_id), ["moment-a"]);
  assert.deepEqual(
    result.moments[0].source_fragments.map((item) => item.fragment_id),
    ["fragment-a", "fragment-b"],
  );
  assert.equal(JSON.stringify(result).includes("private source text"), false);
});

test("Story visibility requires same-group confirmed Moments and active group-visible evidence", () => {
  const proposal = story();
  const confirmed = [
    moment({ id: "moment-1", fragments: ["fragment-1"] }),
    moment({ id: "moment-2", fragments: ["fragment-2"] }),
  ];
  const eligible = [
    fragment({ id: "fragment-1" }),
    fragment({ id: "fragment-2" }),
  ];
  assert.deepEqual(visibleStoriesForMember([proposal], confirmed, eligible), [proposal]);
  assert.deepEqual(
    visibleStoriesForMember([proposal], confirmed, [eligible[0]]),
    [],
  );
  assert.deepEqual(
    visibleStoriesForMember(
      [proposal],
      confirmed,
      [{ ...eligible[0], textContent: "A materially edited source." }, eligible[1]],
    ),
    [],
  );
  assert.deepEqual(
    visibleStoriesForMember(
      [proposal],
      confirmed.map((item) => item.id === "moment-2" ? { ...item, status: "candidate" } : item),
      eligible,
    ),
    [],
  );
  assert.deepEqual(
    visibleStoriesForMember(
      [{ ...proposal, groupId: "group-b" }],
      confirmed,
      eligible,
    ),
    [],
  );
  assert.deepEqual(
    visibleStoriesForMember(
      [proposal],
      confirmed.map((item) => item.id === "moment-2" ? { ...item, revision: 2 } : item),
      eligible,
    ),
    [],
  );
});

test("Story source keys ignore Moment ordering", () => {
  const first = moment({ id: "moment-1", fragments: ["fragment-1"] });
  const second = moment({ id: "moment-2", fragments: ["fragment-2"], offsetDays: 7 });
  assert.equal(
    deriveStorySourceKey([first, second]),
    deriveStorySourceKey([second, first]),
  );
  assert.notEqual(
    deriveStorySourceKey([first, second]),
    deriveStorySourceKey([{ ...second, revision: 2 }, first]),
  );
  assert.notEqual(
    deriveStorySourceKey([first, second], "gemma4:e2b"),
    deriveStorySourceKey([first, second], "gemma4:e2b-next"),
  );
});

test("Story context keys reuse unchanged packets and vary with model or source changes", () => {
  const context = packet();
  assert.equal(
    deriveStoryContextKey(context, "gemma4:e2b"),
    deriveStoryContextKey(context, "gemma4:e2b"),
  );
  assert.notEqual(
    deriveStoryContextKey(context, "gemma4:e2b"),
    deriveStoryContextKey(context, "gemma4:e2b-next"),
  );
  assert.notEqual(
    deriveStoryContextKey(context, "gemma4:e2b"),
    deriveStoryContextKey({
      ...context,
      moments: [{ ...context.moments[0], summary: "A changed Moment summary." }, context.moments[1]],
    }, "gemma4:e2b"),
  );
  assert.notEqual(
    deriveStoryContextKey(context, "gemma4:e2b", [
      { fragmentId: "fragment-1", sourceContentSha256: "digest-a" },
    ]),
    deriveStoryContextKey(context, "gemma4:e2b", [
      { fragmentId: "fragment-1", sourceContentSha256: "digest-b" },
    ]),
  );
});

test("member Story projection omits reviewer, model, cache, and source digest internals", () => {
  const visible = storyForGroupMember(story());
  const serialized = JSON.stringify(visible);
  assert.equal(serialized.includes("reviewHistory"), false);
  assert.equal(serialized.includes("modelVersion"), false);
  assert.equal(serialized.includes("sourceKey"), false);
  assert.equal(serialized.includes("contextKey"), false);
  assert.equal(serialized.includes("fragmentSourceDigests"), false);
});

test("Story upserts are scoped and preserve a member-reviewed candidate", async () => {
  const records = new Map<string, Record<string, unknown>>();
  const filters: Array<Record<string, unknown>> = [];
  const fakeCollection = {
    createIndex: async () => "index",
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      filters.push(filter);
      const existing = [...records.values()].find((record) =>
        Object.entries(filter).every(([key, value]) => record[key] === value),
      );
      if (!existing) {
        const inserted = (update.$setOnInsert ?? {}) as Record<string, unknown>;
        records.set(String(inserted._id), inserted);
      }
      return { modifiedCount: existing ? 0 : 1, upsertedCount: existing ? 0 : 1 };
    },
    findOne: async (filter: Record<string, unknown>) => {
      filters.push(filter);
      return [...records.values()].find((record) =>
        Object.entries(filter).every(([key, value]) => record[key] === value),
      ) ?? null;
    },
  };
  const repository = new MongoStoryRepository({
    collection: () => fakeCollection,
  } as unknown as Db);
  const initial = story();
  const inserted = await repository.insertStoryIfAbsent(initial);
  const reviewed = records.get(inserted.id);
  assert.ok(reviewed);
  reviewed.status = "confirmed";
  reviewed.uncertaintyLabel = "confirmed";
  reviewed.revision = 1;
  const duplicate = await repository.insertStoryIfAbsent({
    ...initial,
    id: "another-story-id",
    title: "A changed model proposal",
  });

  assert.equal(duplicate.id, initial.id);
  assert.equal(duplicate.title, initial.title);
  assert.equal(duplicate.status, "confirmed");
  assert.ok(filters.every((filter) => filter.groupId === "group-a"));
});

test("Story confirmation is member-owned, revision-checked, and auditable", async () => {
  const record: Record<string, unknown> = { _id: "story-1", ...story() };
  let updateFilter: Record<string, unknown> | undefined;
  const fakeCollection = {
    createIndex: async () => "index",
    findOne: async (filter: Record<string, unknown>) =>
      Object.entries(filter).every(([key, value]) => record[key] === value)
        ? record
        : null,
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      updateFilter = filter;
      if (!Object.entries(filter).every(([key, value]) => record[key] === value)) {
        return { modifiedCount: 0 };
      }
      Object.assign(record, update.$set);
      record.revision = Number(record.revision) + Number((update.$inc as { revision: number }).revision);
      const push = update.$push as { reviewHistory: { $each: unknown[] } };
      record.reviewHistory = [...(record.reviewHistory as unknown[]), ...push.reviewHistory.$each];
      return { modifiedCount: 1 };
    },
  };
  const repository = new MongoStoryRepository({
    collection: () => fakeCollection,
  } as unknown as Db);

  const confirmed = await repository.reviewStory({
    groupId: "group-a",
    storyId: "story-1",
    actorUserId: "member-a",
    action: "confirm",
    expectedRevision: 0,
  });
  const stale = await repository.reviewStory({
    groupId: "group-a",
    storyId: "story-1",
    actorUserId: "member-b",
    action: "reject",
    expectedRevision: 0,
  });

  assert.equal(updateFilter?.groupId, "group-a");
  assert.equal(confirmed?.status, "confirmed");
  assert.equal(confirmed?.uncertaintyLabel, "confirmed");
  assert.equal(confirmed?.revision, 1);
  assert.equal(confirmed?.reviewHistory?.[0].actorUserId, "member-a");
  assert.equal(stale, null);
});

test("Story job creation is idempotent within a group and distinct across groups", async () => {
  const records = new Map<string, Record<string, unknown>>();
  const fakeCollection = {
    createIndex: async () => "index",
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      const existing = [...records.values()].find((record) =>
        Object.entries(filter).every(([key, value]) => record[key] === value),
      );
      if (!existing) {
        const inserted = (update.$setOnInsert ?? {}) as Record<string, unknown>;
        records.set(String(inserted._id), inserted);
      }
      return { modifiedCount: existing ? 0 : 1 };
    },
    findOne: async (filter: Record<string, unknown>) =>
      [...records.values()].find((record) =>
        Object.entries(filter).every(([key, value]) => record[key] === value),
      ) ?? null,
  };
  const repository = new MongoStoryRepository({
    collection: () => fakeCollection,
  } as unknown as Db);
  const jobInput = {
    groupId: "group-a",
    requesterUserId: "user-a",
    requestId: "request-uuid",
  };

  const first = await repository.createStoryJob(jobInput);
  const retry = await repository.createStoryJob(jobInput);
  const otherGroup = await repository.createStoryJob({ ...jobInput, groupId: "group-b" });

  assert.equal(first.id, retry.id);
  assert.notEqual(first.id, otherGroup.id);
  assert.equal(records.size, 2);
});

test("Story reconstruction does not call Gemma without two eligible confirmed Moments", async () => {
  let modelCalls = 0;
  let authorizationChecks = 0;
  const cursor = () => ({
    sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
  });
  const database = {
    collection: () => ({
      createIndex: async () => "index",
      find: () => cursor(),
    }),
  } as unknown as Db;
  const result = await reconstructStoryConnection({
    groupId: "group-a",
    database,
    authorizationCheck: async () => {
      authorizationChecks += 1;
    },
    generator: {
      modelVersion: "test-gemma",
      async generateStructured() {
        modelCalls += 1;
        return {};
      },
    },
  });

  assert.equal(authorizationChecks, 1);
  assert.equal(modelCalls, 0);
  assert.deepEqual(result, { outcome: "insufficient_evidence", story: null });
});
