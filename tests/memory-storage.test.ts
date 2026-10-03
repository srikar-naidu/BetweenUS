import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { MongoMemoryRepository } from "../src/lib/repositories/mongodb-memory-repository";
import { TigerDataFragmentSearch } from "../src/lib/retrieval/tiger-data";

test("Mongo repository stores fragments and scopes candidate reads to group-visible records", async () => {
  const saved: Record<string, unknown>[] = [];
  let findFilter: Record<string, unknown> | undefined;
  const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const fakeCollection = {
    createIndex: async () => "index",
    insertOne: async (document: Record<string, unknown>) => {
      saved.push(document);
    },
    find: (filter: Record<string, unknown>) => {
      findFilter = filter;
      return {
        sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
      };
    },
    findOne: async () => null,
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      updates.push({ filter, update });
      return { modifiedCount: 1 };
    },
  };
  const fakeDb = {
    collection: () => fakeCollection,
  } as unknown as Db;
  const repository = new MongoMemoryRepository(fakeDb);
  const capturedAt = new Date("2026-09-04T12:04:00Z");

  const fragment = await repository.createFragment({
    groupId: "group-a",
    authorUserId: "user-a",
    type: "image",
    storageUri: "private://fragment",
    capturedAt,
    visibility: "group",
    aiProcessingConsent: true,
  });
  await repository.findGroupVisibleFragments(
    "group-a",
    new Date("2026-09-04T11:50:00Z"),
    new Date("2026-09-04T12:30:00Z"),
  );

  assert.equal(saved.length, 1);
  assert.equal(fragment.status, "uploaded");
  assert.equal(fragment.visibility, "group");
  assert.equal(fragment.aiProcessingConsent, true);
  assert.equal(fragment.deletionState, "active");
  assert.equal(findFilter?.groupId, "group-a");
  assert.equal(findFilter?.visibility, "group");
  assert.equal(findFilter?.aiProcessingConsent, true);
  assert.equal(findFilter?.deletionState, "active");
  assert.deepEqual(findFilter?.capturedAt, {
    $gte: new Date("2026-09-04T11:50:00Z"),
    $lte: new Date("2026-09-04T12:30:00Z"),
  });
});

test("Mongo fragment reads separate member visibility from AI processing consent", async () => {
  let aiFilter: Record<string, unknown> | undefined;
  let memberFilter: Record<string, unknown> | undefined;
  const fakeCollection = {
    createIndex: async () => "index",
    find: (filter: Record<string, unknown>) => {
      if (filter.aiProcessingConsent === true) aiFilter = filter;
      else memberFilter = filter;
      return {
        sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
      };
    },
  };
  const repository = new MongoMemoryRepository({
    collection: () => fakeCollection,
  } as unknown as Db);

  await repository.findGroupVisibleFragments(
    "group-a",
    new Date("2026-09-04T11:50:00Z"),
    new Date("2026-09-04T12:30:00Z"),
  );
  await repository.findMemberVisibleFragments("group-a", "user-a");

  assert.equal(aiFilter?.aiProcessingConsent, true);
  assert.deepEqual(memberFilter?.$or, [
    { visibility: "group" },
    { authorUserId: "user-a" },
  ]);
  assert.equal(memberFilter?.deletionState, "active");
});

test("fragment and moment reads always scope Mongo filters to the requested group", async () => {
  const fragmentFilters: Record<string, unknown>[] = [];
  const momentFilters: Record<string, unknown>[] = [];
  const cursor = () => ({
    sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
  });
  const fakeDb = {
    collection: (name: string) =>
      name === "fragments"
        ? {
            find: (filter: Record<string, unknown>) => {
              fragmentFilters.push(filter);
              return cursor();
            },
          }
        : {
            findOne: async (filter: Record<string, unknown>) => {
              momentFilters.push(filter);
              return null;
            },
            find: (filter: Record<string, unknown>) => {
              momentFilters.push(filter);
              return cursor();
            },
          },
  } as unknown as Db;
  const repository = new MongoMemoryRepository(fakeDb);
  const startAt = new Date("2026-09-04T11:50:00Z");
  const endAt = new Date("2026-09-04T12:30:00Z");

  await repository.findGroupVisibleFragments("group-a", startAt, endAt);
  await repository.findGroupVisibleFragments("group-b", startAt, endAt);
  await repository.findMemberVisibleFragments("group-a", "user-a");
  await repository.findMemberVisibleFragments("group-b", "user-a");
  await repository.findMoment("group-a", "moment-a");
  await repository.findMoment("group-b", "moment-a");
  await repository.listMoments("group-a");
  await repository.listMoments("group-b");

  assert.deepEqual(fragmentFilters.map((filter) => filter.groupId), [
    "group-a",
    "group-b",
    "group-a",
    "group-b",
  ]);
  assert.deepEqual(momentFilters.map((filter) => filter.groupId), [
    "group-a",
    "group-b",
    "group-a",
    "group-b",
  ]);
});

test("fragment deletion changes state instead of deleting provenance immediately", async () => {
  let capturedUpdate: Record<string, unknown> | undefined;
  let capturedFilter: Record<string, unknown> | undefined;
  let deletionRequestWrite: { filter: Record<string, unknown>; update: Record<string, unknown> } | undefined;
  const multiUpdates: Array<{ collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const fakeCollection = {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      capturedFilter = filter;
      capturedUpdate = update;
      return { modifiedCount: 1, matchedCount: 1 };
    },
  };
  const fakeDb = {
    collection: (name: string) =>
      name === "fragments"
        ? {
            ...fakeCollection,
            updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
              multiUpdates.push({ collection: name, filter, update });
              return { matchedCount: 1, modifiedCount: 1 };
            },
          }
        : {
            updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
              if (name === "deletion_requests") deletionRequestWrite = { filter, update };
              return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
            },
            updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
              multiUpdates.push({ collection: name, filter, update });
              return { matchedCount: 1, modifiedCount: 1 };
            },
          },
  };
  const repository = new MongoMemoryRepository({
    ...fakeDb,
  } as unknown as Db);

  const requested = await repository.requestFragmentDeletion({
    groupId: "group-a",
    fragmentId: "fragment-a",
    actorUserId: "user-a",
    canManageGroup: true,
  });

  assert.equal(requested, true);
  assert.equal(
    (capturedUpdate?.$set as Record<string, unknown>).deletionState,
    "pending",
  );
  assert.ok((capturedUpdate?.$set as Record<string, unknown>).deletionRequestedAt instanceof Date);
  assert.deepEqual(capturedFilter?.$or, [
    { visibility: "group" },
    { authorUserId: "user-a" },
  ]);
  assert.equal(deletionRequestWrite?.filter.targetType, "fragment");
  assert.equal(deletionRequestWrite?.filter.targetId, "fragment-a");
  const deletionRecord = deletionRequestWrite?.update.$setOnInsert as Record<string, unknown>;
  assert.equal(deletionRecord.groupId, "group-a");
  assert.equal(deletionRecord.requestedByUserId, "user-a");
  assert.equal(deletionRecord.status, "pending");
  assert.equal(multiUpdates[0].collection, "moments");
  assert.equal(multiUpdates[0].filter["evidence.fragmentId"], "fragment-a");
  assert.equal((multiUpdates[0].update.$set as Record<string, unknown>).status, "draft");
});

test("Tiger retrieval uses parameterized group/time filters and caps result count", async () => {
  let queryText = "";
  let queryValues: readonly unknown[] = [];
  const search = new TigerDataFragmentSearch({
    query: async (text, values) => {
      queryText = text;
      queryValues = values;
      return {
        rows: [
          {
            fragment_id: "fragment-b",
            captured_at: new Date("2026-09-04T12:08:00Z"),
            semantic_summary: "cafeteria table",
            entity_keys: ["cafeteria"],
          },
        ],
      };
    },
  });

  const candidates = await search.findCandidates({
    groupId: "group-a",
    startAt: new Date("2026-09-04T11:50:00Z"),
    endAt: new Date("2026-09-04T12:30:00Z"),
    excludeFragmentId: "fragment-a",
    searchText: "cafeteria",
    limit: 500,
  });

  assert.match(queryText, /group_id = \$1/);
  assert.match(queryText, /captured_at >= \$2/);
  assert.match(queryText, /ORDER BY abs\(extract\(epoch/);
  assert.deepEqual(queryValues.slice(0, 5), [
    "group-a",
    new Date("2026-09-04T11:50:00Z"),
    new Date("2026-09-04T12:30:00Z"),
    "fragment-a",
    "cafeteria",
  ]);
  assert.equal(queryValues[6], 100);
  assert.equal(candidates[0].fragmentId, "fragment-b");
});

test("new fragments default private and do not grant AI processing consent", async () => {
  let inserted: Record<string, unknown> | undefined;
  const fakeDb = {
    collection: () => ({
      insertOne: async (document: Record<string, unknown>) => {
        inserted = document;
      },
    }),
  } as unknown as Db;
  const repository = new MongoMemoryRepository(fakeDb);

  const fragment = await repository.createFragment({
    groupId: "group-a",
    authorUserId: "user-a",
    type: "text",
    storageUri: "private://note",
    capturedAt: new Date("2026-09-04T12:04:00Z"),
  });

  assert.equal(fragment.visibility, "private");
  assert.equal(fragment.aiProcessingConsent, false);
  assert.equal(fragment.aiProcessingConsentAt, null);
  assert.equal(fragment.deletionState, "active");
  assert.equal(inserted?.aiProcessingConsent, false);
});

test("fragment creation retries with the same scoped ID return the original record", async () => {
  const documents = new Map<string, Record<string, unknown>>();
  const fakeCollection = {
    insertOne: async (document: Record<string, unknown>) => {
      const id = String(document._id);
      if (documents.has(id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
      documents.set(id, document);
    },
    findOne: async (filter: Record<string, unknown>) => {
      const document = documents.get(String(filter._id));
      if (!document || document.groupId !== filter.groupId || document.authorUserId !== filter.authorUserId) {
        return null;
      }
      return document;
    },
  };
  const repository = new MongoMemoryRepository({
    collection: () => fakeCollection,
  } as unknown as Db);
  const input = {
    id: "stable-fragment-id",
    groupId: "group-a",
    authorUserId: "user-a",
    type: "text" as const,
    textContent: "A note",
    source: "text" as const,
    capturedAt: new Date("2026-09-04T12:04:00Z"),
  };

  const first = await repository.createFragment(input);
  const retry = await repository.createFragment(input);
  assert.equal(first.id, retry.id);
  assert.equal(documents.size, 1);
  await assert.rejects(repository.createFragment({ ...input, groupId: "group-b" }));
});

test("group deletion marks the group pending and creates a cleanup request", async () => {
  const updates: Array<{ collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const multiUpdates: Array<{ collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const fakeDb = {
    collection: (name: string) => ({
      updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        updates.push({ collection: name, filter, update });
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      },
      updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        multiUpdates.push({ collection: name, filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      },
    }),
  } as unknown as Db;
  const repository = new MongoMemoryRepository(fakeDb);

  const requested = await repository.requestGroupDeletion({
    groupId: "64b000000000000000000001",
    requestedByUserId: "64b000000000000000000002",
  });

  assert.equal(requested, true);
  assert.equal(updates[0].collection, "groups");
  assert.equal((updates[0].update.$set as Record<string, unknown>).lifecycleStatus, "deletion_pending");
  assert.equal(multiUpdates[0].collection, "fragments");
  assert.equal((multiUpdates[0].update.$set as Record<string, unknown>).aiProcessingConsent, false);
  assert.equal(multiUpdates[1].collection, "moments");
  assert.equal((multiUpdates[1].update.$set as Record<string, unknown>).status, "draft");
  assert.equal(updates[1].collection, "deletion_requests");
  assert.equal((updates[1].update.$setOnInsert as Record<string, unknown>).status, "pending");
});