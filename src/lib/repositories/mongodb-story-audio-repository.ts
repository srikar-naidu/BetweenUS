import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GridFSBucket, ObjectId } from "mongodb";
import type { Collection, Db, Document } from "mongodb";

export type StoryAudioJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface StoryAudioJob {
  id: string;
  groupId: string;
  requesterUserId: string;
  storyRevision: number;
  requestId: string;
  status: StoryAudioJobStatus;
  attemptCount: number;
  errorCategory: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type StoredStoryAudioJob = Omit<StoryAudioJob, "id"> & { _id: string } & Document;
interface ProviderUsageDocument extends Document {
  _id: string;
  provider: string;
  feature: string;
  count: number;
  updatedAt?: Date;
}

function asJob(record: StoredStoryAudioJob): StoryAudioJob {
  const { _id, ...job } = record;
  return { ...job, id: _id };
}

export class MongoStoryAudioRepository {
  private readonly jobs: Collection<StoredStoryAudioJob>;
  private readonly files: GridFSBucket;

  constructor(private readonly database: Db) {
    this.jobs = database.collection<StoredStoryAudioJob>("event_story_audio_jobs");
    this.files = new GridFSBucket(database, { bucketName: "event_story_audio" });
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.jobs.createIndex({ groupId: 1, storyRevision: 1, requestId: 1 }, { unique: true }),
      this.jobs.createIndex(
        { groupId: 1, storyRevision: 1 },
        {
          unique: true,
          partialFilterExpression: { status: { $in: ["queued", "running", "succeeded"] } },
        },
      ),
      this.jobs.createIndex({ groupId: 1, storyRevision: 1, status: 1, createdAt: -1 }),
      this.jobs.createIndex({ status: 1, createdAt: 1 }),
      this.database.collection("event_story_audio.files")
        .createIndex({ "metadata.groupId": 1, "metadata.storyRevision": 1 }),
    ]);
  }

  async createOrFind(input: {
    groupId: string;
    requesterUserId: string;
    storyRevision: number;
    requestId: string;
  }): Promise<{ job: StoryAudioJob; created: boolean }> {
    await this.ensureIndexes();
    const id = `event-story-audio:${input.groupId}:${input.storyRevision}:${input.requestId}`;
    const now = new Date();
    let created = false;
    try {
      const result = await this.jobs.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            _id: id,
            ...input,
            status: "queued",
            attemptCount: 0,
            errorCategory: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
      created = result.upsertedCount === 1;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== 11000
      ) {
        throw error;
      }
    }
    const record = await this.jobs.findOne(
      created ? { _id: id } : { groupId: input.groupId, storyRevision: input.storyRevision },
      { sort: { createdAt: -1 } },
    );
    if (!record) throw new Error("Story audio job could not be read after upsert");
    return { job: asJob(record), created };
  }

  async find(jobId: string, groupId: string): Promise<StoryAudioJob | null> {
    await this.ensureIndexes();
    const record = await this.jobs.findOne({ _id: jobId, groupId });
    return record ? asJob(record) : null;
  }

  async findLatest(groupId: string): Promise<StoryAudioJob | null> {
    await this.ensureIndexes();
    const record = await this.jobs.findOne({ groupId }, { sort: { storyRevision: -1 } });
    return record ? asJob(record) : null;
  }

  async findForRevision(groupId: string, storyRevision: number): Promise<StoryAudioJob | null> {
    await this.ensureIndexes();
    const record = await this.jobs.findOne(
      { groupId, storyRevision, status: "succeeded" },
      { sort: { createdAt: -1 } },
    );
    return record ? asJob(record) : null;
  }

  async findActiveOrLatestForRevision(
    groupId: string,
    storyRevision: number,
  ): Promise<StoryAudioJob | null> {
    await this.ensureIndexes();
    const record = await this.jobs.findOne(
      { groupId, storyRevision },
      { sort: { createdAt: -1 } },
    );
    return record ? asJob(record) : null;
  }

  async reserveMonthlyGeneration(monthlyLimit: number): Promise<boolean> {
    const date = new Date();
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const id = `elevenlabs-story-audio:${month}`;
    const usage = this.database.collection<ProviderUsageDocument>("provider_usage");
    try {
      await usage.updateOne(
        { _id: id },
        { $setOnInsert: { provider: "elevenlabs", feature: "story_audio", count: 0 } },
        { upsert: true },
      );
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== 11000
      ) {
        throw error;
      }
    }
    const result = await usage.updateOne(
      { _id: id, count: { $lt: monthlyLimit } },
      { $inc: { count: 1 }, $set: { updatedAt: date } },
    );
    return result.modifiedCount === 1;
  }

  async markFailed(jobId: string, errorCategory: string): Promise<void> {
    await this.jobs.updateOne(
      { _id: jobId, status: { $in: ["queued", "running"] } },
      { $set: { status: "failed", errorCategory, updatedAt: new Date() } },
    );
  }

  async saveAudio(job: StoryAudioJob, bytes: Uint8Array): Promise<void> {
    const upload = this.files.openUploadStream(job.id, {
      metadata: {
        groupId: job.groupId,
        storyRevision: job.storyRevision,
      },
    });
    await pipeline(Readable.from([Buffer.from(bytes)]), upload);
    try {
      const result = await this.jobs.updateOne(
        { _id: job.id, groupId: job.groupId, status: "running" },
        { $set: { status: "succeeded", errorCategory: null, updatedAt: new Date() } },
      );
      if (result.modifiedCount !== 1) {
        throw new Error("Story audio job is no longer active");
      }
    } catch (error) {
      await this.files.delete(upload.id);
      throw error;
    }
  }

  async openAudio(jobId: string, groupId: string): Promise<NodeJS.ReadableStream | null> {
    await this.ensureIndexes();
    const job = await this.jobs.findOne({ _id: jobId, groupId, status: "succeeded" });
    if (!job) return null;
    const file = await this.database.collection("event_story_audio.files").findOne({
      filename: jobId,
      "metadata.groupId": groupId,
    });
    if (!file?._id || !(file._id instanceof ObjectId)) return null;
    return this.files.openDownloadStream(file._id);
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.ensureIndexes();
    const files = await this.database.collection("event_story_audio.files")
      .find({ "metadata.groupId": groupId }, { projection: { _id: 1 } })
      .toArray();
    await Promise.all(files.flatMap(({ _id }) =>
      _id instanceof ObjectId ? [this.files.delete(_id)] : [],
    ));
    await this.jobs.deleteMany({ groupId });
  }

  async deleteOlderRevisions(groupId: string, storyRevision: number): Promise<void> {
    await this.ensureIndexes();
    const files = await this.database.collection("event_story_audio.files")
      .find({
        "metadata.groupId": groupId,
        "metadata.storyRevision": { $lt: storyRevision },
      }, { projection: { _id: 1 } })
      .toArray();
    await Promise.all(files.flatMap(({ _id }) =>
      _id instanceof ObjectId ? [this.files.delete(_id)] : [],
    ));
    await this.jobs.deleteMany({ groupId, storyRevision: { $lt: storyRevision } });
  }
}
