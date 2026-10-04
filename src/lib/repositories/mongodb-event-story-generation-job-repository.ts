import { randomUUID } from "node:crypto";
import type { Collection, Db, Document } from "mongodb";
import type { EventStoryGenerationJob } from "@/lib/domain/memory";

type StoredJob = Omit<EventStoryGenerationJob, "id"> & { _id: string } & Document;

const globalForEventStoryJobs = globalThis as typeof globalThis & {
  betweenUsEventStoryJobIndexes?: WeakMap<Db, Promise<void>>;
};
const eventStoryJobIndexes = (globalForEventStoryJobs.betweenUsEventStoryJobIndexes ??= new WeakMap());

function asJob(record: StoredJob): EventStoryGenerationJob {
  const { _id, ...job } = record;
  return { ...job, id: _id };
}

export class MongoEventStoryGenerationJobRepository {
  private readonly jobs: Collection<StoredJob>;

  constructor(private readonly database: Db) {
    this.jobs = database.collection<StoredJob>("event_story_generation_jobs");
  }

  async ensureIndexes(): Promise<void> {
    let pending = eventStoryJobIndexes.get(this.database);
    if (!pending) {
      pending = Promise.all([
        this.jobs.createIndex({ groupId: 1, createdAt: -1 }),
        this.jobs.createIndex({ groupId: 1, requesterUserId: 1, status: 1 }),
      ]).then(() => undefined);
      eventStoryJobIndexes.set(this.database, pending);
    }
    try {
      await pending;
    } catch (error) {
      eventStoryJobIndexes.delete(this.database);
      throw error;
    }
  }

  async create(input: Omit<EventStoryGenerationJob, "id" | "status" | "workflowId" | "errorCategory" | "createdAt" | "updatedAt">): Promise<EventStoryGenerationJob> {
    await this.ensureIndexes();
    const now = new Date();
    const job: StoredJob = {
      _id: randomUUID(),
      ...input,
      status: "queued",
      workflowId: null,
      errorCategory: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.jobs.insertOne(job);
    return asJob(job);
  }

  async find(jobId: string, groupId?: string): Promise<EventStoryGenerationJob | null> {
    await this.ensureIndexes();
    const record = await this.jobs.findOne({ _id: jobId, ...(groupId ? { groupId } : {}) });
    return record ? asJob(record) : null;
  }

  async findLatest(groupId: string, requesterUserId: string): Promise<EventStoryGenerationJob | null> {
    await this.ensureIndexes();
    const record = await this.jobs.findOne({ groupId, requesterUserId }, { sort: { createdAt: -1 } });
    return record ? asJob(record) : null;
  }

  async markRunning(jobId: string, workflowId: string): Promise<void> {
    await this.ensureIndexes();
    await this.jobs.updateOne(
      { _id: jobId, status: { $in: ["queued", "running"] } },
      { $set: { status: "running", workflowId, updatedAt: new Date() } },
    );
  }

  async markSucceeded(jobId: string): Promise<void> {
    await this.ensureIndexes();
    await this.jobs.updateOne(
      { _id: jobId, status: { $in: ["queued", "running"] } },
      { $set: { status: "succeeded", errorCategory: null, updatedAt: new Date() } },
    );
  }

  async markFailed(jobId: string, errorCategory: string): Promise<void> {
    await this.ensureIndexes();
    await this.jobs.updateOne(
      { _id: jobId, status: { $in: ["queued", "running"] } },
      { $set: { status: "failed", errorCategory, updatedAt: new Date() } },
    );
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.ensureIndexes();
    await this.jobs.deleteMany({ groupId });
  }
}
