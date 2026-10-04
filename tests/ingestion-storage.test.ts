import assert from "node:assert/strict";
import test from "node:test";
import { MongoIngestionRepository } from "../src/lib/repositories/mongodb-ingestion-repository";

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
    requesterUserId: "user-a",
  };

  const first = await repository.upsertProcessingJob(input);
  const retry = await repository.upsertProcessingJob(input);
  const otherGroup = await repository.upsertProcessingJob({ ...input, groupId: "group-b" });
  const nextVersion = await repository.upsertProcessingJob({ ...input, processingVersion: "ingest-v2" });
  const reconstruction = await repository.upsertProcessingJob({
    ...input,
    jobType: "reconstruct_moment",
    processingVersion: "moment-reconstruction-v1-request-a",
  });

  assert.equal(first.id, retry.id);
  assert.notEqual(first.id, otherGroup.id);
  assert.notEqual(first.id, nextVersion.id);
  assert.notEqual(reconstruction.id, first.id);
  assert.equal(reconstruction.jobType, "reconstruct_moment");
  assert.equal(first.requesterUserId, "user-a");
  assert.equal(documents.length, 4);
});

test("fragment processing status excludes separate moment reconstruction jobs", async () => {
  let query: Record<string, unknown> | undefined;
  const repository = new MongoIngestionRepository({
    collection: () => ({
      createIndex: async () => "index",
      find: (filter: Record<string, unknown>) => {
        query = filter;
        return {
          sort: () => ({
            toArray: async () => [
              {
                groupId: "group-a",
                fragmentId: "fragment-a",
                jobType: "reconstruct_moment",
                status: "running",
                updatedAt: new Date("2026-10-04T12:02:00Z"),
              },
              {
                groupId: "group-a",
                fragmentId: "fragment-a",
                jobType: "ingest",
                status: "succeeded",
                updatedAt: new Date("2026-10-04T12:01:00Z"),
              },
            ].filter((record) => record.jobType === filter.jobType),
          }),
        };
      },
    }),
  } as never);

  const statuses = await repository.latestProcessingStatusByFragmentIds("group-a", ["fragment-a"]);

  assert.equal(query?.jobType, "ingest");
  assert.equal(statuses.get("fragment-a"), "succeeded");
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
