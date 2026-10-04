import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import type { BackboardClient } from "../src/lib/integrations/backboard-client";
import type { Fragment, Moment } from "../src/lib/domain/memory";
import {
  GroupBackboardMemoryError,
  publishConfirmedCorrection,
  searchConfirmedGroupMemories,
  deleteCorrectionMemory,
} from "../src/lib/pipeline/group-backboard-memory";

const now = new Date("2026-10-04T12:00:00Z");

function makeMoment(status: Moment["status"] = "confirmed"): Moment {
  return {
    id: "moment-a",
    groupId: "group-a",
    title: null,
    summary: "Members met near the cafe.",
    confidence: 0.6,
    uncertaintyLabel: status === "confirmed" ? "confirmed" : "possible",
    uncertaintyReason: "Member review.",
    startAt: now,
    endAt: now,
    status,
    evidence: [{ fragmentId: "fragment-a", relationship: "shared_location" }],
    reviewHistory: [],
    corrections: [{
      id: "correction-a",
      type: "place",
      fragmentId: "fragment-a",
      value: "North cafe",
    }],
    revision: 1,
    mergedIntoMomentId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeFragment(): Fragment {
  return {
    id: "fragment-a",
    groupId: "group-a",
    authorUserId: "user-a",
    type: "text",
    storageUri: null,
    caption: null,
    textContent: "We met at North cafe after class.",
    source: "text",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "fragment-analysis-v1",
    capturedAt: now,
    createdAt: now,
    metadata: {},
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: now,
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  };
}

function makeDatabase(input: {
  moment?: Moment;
  memoryLinks?: Array<Record<string, unknown>>;
} = {}) {
  const moment = input.moment ?? makeMoment();
  const links = new Map(
    (input.memoryLinks ?? []).map((link) => [String(link._id), link]),
  );
  const integration = {
    _id: "group-a",
    groupId: "group-a",
    assistantId: "assistant-a",
    status: "enabled",
    enabledByUserId: "owner-a",
    updatedAt: now,
  };
  const database = {
    collection(name: string) {
      return {
        createIndex: async () => "index",
        findOne: async (filter: Record<string, unknown>) => {
          if (name === "group_backboard_integrations") {
            return filter._id === "group-a" ? integration : null;
          }
          if (name === "moments") {
            return filter._id === moment.id && filter.groupId === moment.groupId
              ? { ...moment, _id: moment.id }
              : null;
          }
          if (name === "group_backboard_memories") {
            return [...links.values()].find((link) =>
              link.groupId === filter.groupId && link.correctionId === filter.correctionId,
            ) ?? null;
          }
          return null;
        },
        find: (filter: Record<string, unknown>) => ({
          toArray: async () => {
            if (name === "fragments") {
              const ids = (filter._id as { $in?: string[] } | undefined)?.$in ?? [];
              return ids.includes("fragment-a") ? [{ ...makeFragment(), _id: "fragment-a" }] : [];
            }
            if (name === "group_backboard_memories") {
              const ids = (filter.memoryId as { $in?: string[] } | undefined)?.$in ?? [];
              return [...links.values()].filter((link) =>
                link.groupId === filter.groupId &&
                ids.includes(String(link.memoryId)) &&
                link.status === "synced",
              );
            }
            return [];
          },
        }),
        updateOne: async (
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
        ) => {
          if (name === "group_backboard_memories") {
            const match = [...links.entries()].find(([id, link]) =>
              id === filter._id ||
              (link.groupId === filter.groupId && link.correctionId === filter.correctionId),
            );
            const id = match?.[0] ?? String(filter._id);
            const current = match?.[1] ?? update.$setOnInsert as Record<string, unknown>;
            const updated = { ...current, ...(update.$set as Record<string, unknown> ?? {}) };
            links.set(id, updated);
          }
          return { modifiedCount: 1, matchedCount: 1 };
        },
        insertOne: async (document: Record<string, unknown>) => {
          if (name === "group_backboard_memories") links.set(String(document._id), document);
          return { acknowledged: true };
        },
        deleteOne: async (filter: Record<string, unknown>) => {
          if (name === "group_backboard_memories") {
            const match = [...links.entries()].find(([, link]) =>
              link.groupId === filter.groupId && link.correctionId === filter.correctionId,
            );
            if (match) links.delete(match[0]);
          }
          return { deletedCount: 1 };
        },
      };
    },
  };
  return { database: database as unknown as Db, links, integration };
}

test("sharing writes only a member-selected correction after confirmation", async () => {
  const { database, links } = makeDatabase();
  let added: Record<string, unknown> | undefined;
  const provider = {
    addMemory: async (input: Record<string, unknown>) => {
      added = input;
      return { memoryId: "provider-memory-a", operationId: null };
    },
  } as unknown as BackboardClient;

  const result = await publishConfirmedCorrection({
    database,
    groupId: "group-a",
    momentId: "moment-a",
    correctionId: "correction-a",
    provider,
  });

  assert.equal(result, "synced");
  assert.equal(added?.assistantId, "assistant-a");
  assert.equal(added?.content, "Group-confirmed place reference: North cafe");
  assert.match(String(added?.sourceKey), /^[a-f0-9]{64}$/);
  assert.equal(added?.correctionType, "place");
  assert.equal(String(added?.content).includes("We met at North cafe after class."), false);
  const link = links.get("group-a:correction-a");
  assert.equal(link?.status, "synced");
  assert.equal(link?.memoryId, "provider-memory-a");
});

test("a group disabled during sharing immediately removes the provider memory", async () => {
  const { database, links, integration } = makeDatabase();
  let removedMemoryId: string | undefined;
  const provider = {
    addMemory: async () => {
      integration.status = "disabled";
      return { memoryId: "provider-memory-a", operationId: null };
    },
    deleteMemory: async (input: { memoryId: string }) => {
      removedMemoryId = input.memoryId;
      return null;
    },
  } as unknown as BackboardClient;

  await assert.rejects(
    publishConfirmedCorrection({
      database,
      groupId: "group-a",
      momentId: "moment-a",
      correctionId: "correction-a",
      provider,
    }),
    GroupBackboardMemoryError,
  );
  assert.equal(removedMemoryId, "provider-memory-a");
  assert.equal(links.has("group-a:correction-a"), false);
});

test("pending provider writes retain operation references until confirmed complete", async () => {
  const { database, links } = makeDatabase();
  const provider = {
    addMemory: async () => ({ memoryId: "", operationId: "provider-operation-a" }),
    waitForOperation: async (
      _operationId: string,
      onStatus: (status: string) => Promise<void>,
    ) => {
      await onStatus("in_progress");
      assert.equal(links.get("group-a:correction-a")?.operationId, "provider-operation-a");
      await onStatus("completed");
      return { memory_id: "provider-memory-a" };
    },
  } as unknown as BackboardClient;

  const result = await publishConfirmedCorrection({
    database,
    groupId: "group-a",
    momentId: "moment-a",
    correctionId: "correction-a",
    provider,
  });

  assert.equal(result, "synced");
  assert.equal(links.get("group-a:correction-a")?.operationId, null);
  assert.equal(links.get("group-a:correction-a")?.status, "synced");
});

test("unconfirmed Moments cannot write group memories", async () => {
  const { database } = makeDatabase({ moment: makeMoment("candidate") });
  let wasCalled = false;
  const provider = {
    addMemory: async () => {
      wasCalled = true;
      return { memoryId: "should-not-exist", operationId: null };
    },
  } as unknown as BackboardClient;

  await assert.rejects(
    publishConfirmedCorrection({
      database,
      groupId: "group-a",
      momentId: "moment-a",
      correctionId: "correction-a",
      provider,
    }),
    GroupBackboardMemoryError,
  );
  assert.equal(wasCalled, false);
});

test("retrieval returns only exact, provenance-backed memories for this group", async () => {
  const content = "Group-confirmed place reference: North cafe";
  const { database } = makeDatabase({
    memoryLinks: [
      {
        _id: "group-a:correction-a",
        id: "group-a:correction-a",
        groupId: "group-a",
        momentId: "moment-a",
        correctionId: "correction-a",
        fragmentId: "fragment-a",
        correctionType: "place",
        content,
        memoryId: "provider-memory-a",
        operationId: null,
        operationKind: null,
        status: "synced",
        updatedAt: now,
      },
      {
        _id: "group-b:correction-b",
        id: "group-b:correction-b",
        groupId: "group-b",
        momentId: "moment-b",
        correctionId: "correction-b",
        fragmentId: "fragment-b",
        correctionType: "reference",
        content: "Other group's private memory",
        memoryId: "foreign-memory",
        operationId: null,
        operationKind: null,
        status: "synced",
        updatedAt: now,
      },
    ],
  });
  const provider = {
    searchMemories: async (_input: Record<string, unknown>) => [
      { id: "foreign-memory", content: "Other group's private memory", score: 1 },
      { id: "provider-memory-a", content, score: 0.9 },
      { id: "provider-memory-a", content: "Tampered provider content", score: 0.8 },
    ],
  } as unknown as BackboardClient;

  const memories = await searchConfirmedGroupMemories({
    database,
    groupId: "group-a",
    query: "cafe",
    provider,
    limit: 3,
  });

  assert.deepEqual(memories, [{
    memoryId: "provider-memory-a",
    momentId: "moment-a",
    correctionType: "place",
    content,
  }]);
});

test("unsharing deletes the provider memory before removing Mongo provenance", async () => {
  const content = "Group-confirmed place reference: North cafe";
  const { database, links } = makeDatabase({
    memoryLinks: [{
      _id: "group-a:correction-a",
      groupId: "group-a",
      momentId: "moment-a",
      correctionId: "correction-a",
      fragmentId: "fragment-a",
      correctionType: "place",
      content,
      memoryId: "provider-memory-a",
      operationId: null,
      operationKind: null,
      status: "synced",
      updatedAt: now,
    }],
  });
  let deletedMemoryId: string | undefined;
  const provider = {
    deleteMemory: async (input: { memoryId: string }) => {
      deletedMemoryId = input.memoryId;
      return null;
    },
  } as unknown as BackboardClient;

  await deleteCorrectionMemory({
    database,
    groupId: "group-a",
    correctionId: "correction-a",
    provider,
  });

  assert.equal(deletedMemoryId, "provider-memory-a");
  assert.equal(links.has("group-a:correction-a"), false);
});
