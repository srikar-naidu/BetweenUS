import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { MongoBackgroundJobQueue } from "@/lib/processing/mongodb-background-job-queue";

type JobDocument = Record<string, unknown> & { _id: string };

class FakeCollection {
  constructor(private readonly documents: JobDocument[]) {}

  async createIndex(): Promise<string> {
    return "index";
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
  ): Promise<JobDocument | null> {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    if (!document) return null;
    Object.assign(document, update.$set);
    for (const [key, amount] of Object.entries(update.$inc ?? {})) {
      document[key] = Number(document[key] ?? 0) + Number(amount);
    }
    return structuredClone(document);
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
  ): Promise<{ modifiedCount: number }> {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    if (!document) return { modifiedCount: 0 };
    Object.assign(document, update.$set);
    for (const key of Object.keys(update.$unset ?? {})) delete document[key];
    return { modifiedCount: 1 };
  }
}

function matches(document: JobDocument, filter: Record<string, unknown>): boolean {
  const branches = filter.$or as Array<Record<string, unknown>> | undefined;
  if (branches && !branches.some((branch) => matches(document, branch))) return false;

  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") continue;
    const actual = document[key];
    if (typeof expected !== "object" || expected === null) {
      if (actual !== expected) return false;
      continue;
    }
    const operators = expected as Record<string, unknown>;
    if ("$in" in operators && !(operators.$in as unknown[]).includes(actual)) return false;
    if ("$lte" in operators && (!(actual instanceof Date) || actual > (operators.$lte as Date))) return false;
    if ("$exists" in operators && ((actual !== undefined) !== operators.$exists)) return false;
  }
  return true;
}

function makeQueue(documents: Record<string, JobDocument[]>): MongoBackgroundJobQueue {
  const collections = new Map(
    Object.entries(documents).map(([name, jobs]) => [name, new FakeCollection(jobs)]),
  );
  const database = {
    collection: (name: string) => collections.get(name),
  } as unknown as Db;
  return new MongoBackgroundJobQueue(database);
}

test("claims queued jobs atomically and releases its lease", async () => {
  const queue = makeQueue({
    processing_jobs: [{
      _id: "ingest:group:fragment:v1",
      groupId: "group",
      fragmentId: "fragment",
      jobType: "ingest",
      status: "queued",
      attemptCount: 0,
      createdAt: new Date(),
    }],
    story_reconstruction_jobs: [],
    event_story_generation_jobs: [],
  });
  await queue.ensureIndexes();

  const claimed = await queue.claimNext("worker-a");
  assert.ok(claimed);
  assert.equal(claimed.attemptCount, 1);
  assert.equal(claimed.collection, "processing_jobs");
  assert.equal(await queue.claimNext("worker-b"), null);

  await queue.release(claimed);
  assert.equal(await queue.extendLease(claimed), false);
});

test("reclaims an expired worker lease and increments the attempt count", async () => {
  const queue = makeQueue({
    processing_jobs: [{
      _id: "ingest:group:fragment:v1",
      groupId: "group",
      fragmentId: "fragment",
      jobType: "ingest",
      status: "running",
      attemptCount: 1,
      workerLeaseId: "dead-worker:lease",
      workerLeaseUntil: new Date(Date.now() - 1_000),
      createdAt: new Date(),
    }],
    story_reconstruction_jobs: [],
    event_story_generation_jobs: [],
  });

  const reclaimed = await queue.claimNext("worker-b");
  assert.ok(reclaimed);
  assert.equal(reclaimed.attemptCount, 2);
  assert.match(reclaimed.workerLeaseId, /^worker-b:/);
  assert.equal(await queue.extendLease(reclaimed), true);
});
