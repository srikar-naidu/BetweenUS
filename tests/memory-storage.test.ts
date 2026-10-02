import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { MongoMemoryRepository } from "../src/lib/repositories/mongodb-memory-repository";
import { TigerDataFragmentSearch } from "../src/lib/retrieval/tiger-data";

test("Mongo repository stores fragments and scopes candidate reads to group-visible records", async () => {
  const saved: Record<string, unknown>[] = [];
  let findFilter: Record<string, unknown> | undefined;
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
  });
  await repository.findGroupVisibleFragments(
    "group-a",
    new Date("2026-09-04T11:50:00Z"),
    new Date("2026-09-04T12:30:00Z"),
  );

  assert.equal(saved.length, 1);
  assert.equal(fragment.status, "uploaded");
  assert.equal(fragment.visibility, "group");
  assert.equal(findFilter?.groupId, "group-a");
  assert.equal(findFilter?.visibility, "group");
  assert.deepEqual(findFilter?.capturedAt, {
    $gte: new Date("2026-09-04T11:50:00Z"),
    $lte: new Date("2026-09-04T12:30:00Z"),
  });
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