import assert from "node:assert/strict";
import test from "node:test";
import { MongoIngestionRepository } from "../src/lib/repositories/mongodb-ingestion-repository";
import { getTemporalSettings } from "../src/lib/processing/temporal-client";
import { isPrivateObjectStorageConfigured } from "../src/lib/storage/r2-object-store";

test("R2 storage remains disabled until all private credentials are present", () => {
  assert.equal(isPrivateObjectStorageConfigured({}), false);
  assert.equal(isPrivateObjectStorageConfigured({
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
  }), false);
  assert.equal(isPrivateObjectStorageConfigured({
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "between-us-private",
  }), true);
});

test("Temporal configuration supports local and Cloud endpoints without logging credentials", () => {
  assert.equal(getTemporalSettings({}), null);
  assert.deepEqual(getTemporalSettings({
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_NAMESPACE: "default",
  }), {
    address: "localhost:7233",
    namespace: "default",
    taskQueue: "between-us-processing",
  });
  assert.deepEqual(getTemporalSettings({
    TEMPORAL_ADDRESS: "tenant.tmprl.cloud:7233",
    TEMPORAL_NAMESPACE: "tenant.account",
    TEMPORAL_TASK_QUEUE: "private-processing",
    TEMPORAL_API_KEY: "not-printed",
  }), {
    address: "tenant.tmprl.cloud:7233",
    namespace: "tenant.account",
    taskQueue: "private-processing",
    apiKey: "not-printed",
  });
});

test("processing job upserts are stable and scoped to group, fragment, and version", async () => {
  const documents: Array<Record<string, unknown>> = [];
  const collection = {
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: { upsert?: boolean },
    ) => {
      let existing = documents.find((document) => document._id === filter._id);
      if (!existing && options?.upsert) {
        existing = update.$setOnInsert as Record<string, unknown>;
        documents.push(existing);
        return { upsertedCount: 1, modifiedCount: 0 };
      }
      return { upsertedCount: 0, modifiedCount: existing ? 1 : 0 };
    },
    findOne: async (filter: Record<string, unknown>) =>
      documents.find((document) => document._id === filter._id && document.groupId === filter.groupId) ?? null,
    createIndex: async () => "index",
  };
  const repository = new MongoIngestionRepository({
    collection: () => collection,
  } as never);
  const input = {
    groupId: "group-a",
    fragmentId: "fragment-a",
    jobType: "ingest" as const,
    processingVersion: "ingest-v1",
  };

  const first = await repository.upsertProcessingJob(input);
  const retry = await repository.upsertProcessingJob(input);
  const otherGroup = await repository.upsertProcessingJob({ ...input, groupId: "group-b" });
  const nextVersion = await repository.upsertProcessingJob({ ...input, processingVersion: "ingest-v2" });

  assert.equal(first.id, retry.id);
  assert.notEqual(first.id, otherGroup.id);
  assert.notEqual(first.id, nextVersion.id);
  assert.equal(documents.length, 3);
});

test("failed ingestion and deletion jobs can only reset to queued for their original job type", async () => {
  const calls: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const collection = {
    createIndex: async () => "index",
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      calls.push({ filter, update });
      return { modifiedCount: 1 };
    },
  };
  const repository = new MongoIngestionRepository({
    collection: () => collection,
  } as never);

  assert.equal(await repository.resetFailedProcessingJobForRetry({
    groupId: "group-a",
    id: "delete_fragment:group-a:fragment-a:ingest-v1",
    jobType: "delete_fragment",
  }), true);
  assert.equal(calls[0].filter.jobType, "delete_fragment");
  assert.equal(calls[0].filter.status, "failed");
  assert.equal((calls[0].update.$set as Record<string, unknown>).status, "queued");
});

test("completed fragment cleanup scrubs text/metadata and finalizes an empty pending group", async () => {
  const writes: Array<{ collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const collections = new Map<string, Record<string, (...args: never[]) => unknown>>();
  collections.set("fragments", {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      writes.push({ collection: "fragments", filter, update });
      return { modifiedCount: 1 };
    },
    countDocuments: async () => 0,
  } as never);
  collections.set("deletion_requests", {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      writes.push({ collection: "deletion_requests", filter, update });
      return { modifiedCount: 1 };
    },
  } as never);
  collections.set("groups", {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      writes.push({ collection: "groups", filter, update });
      return { matchedCount: 1, modifiedCount: 1 };
    },
  } as never);
  const repository = new MongoIngestionRepository({
    collection: (name: string) => collections.get(name),
  } as never);

  await repository.markFragmentDeletionComplete("507f1f77bcf86cd799439011", "fragment-a");

  const fragmentUpdate = writes.find((write) => write.collection === "fragments")?.update.$set as Record<string, unknown>;
  assert.equal(fragmentUpdate.deletionState, "deleted");
  assert.equal(fragmentUpdate.textContent, null);
  assert.equal(fragmentUpdate.caption, null);
  assert.deepEqual(fragmentUpdate.metadata, {});
  assert.equal(fragmentUpdate.checksumSha256, null);
  assert.equal(writes.some((write) => write.collection === "groups"), true);
  assert.equal(writes.some((write) => write.collection === "deletion_requests" && write.update.$setOnInsert === undefined), true);
});
