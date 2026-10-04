import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type {
  Story,
  StoryReconstructionJob,
  StoryReviewEvent,
} from "@/lib/domain/memory";

type StoredStory = Omit<Story, "id"> & { _id: string };
type StoredJob = Omit<StoryReconstructionJob, "id"> & { _id: string };

const globalForStoryIndexes = globalThis as typeof globalThis & {
  betweenUsStoryIndexes?: WeakMap<Db, Promise<void>>;
};
const storyIndexes = (globalForStoryIndexes.betweenUsStoryIndexes ??= new WeakMap());

function asStory(record: StoredStory): Story {
  const { _id, ...story } = record;
  return {
    ...story,
    id: _id,
    reviewHistory: story.reviewHistory ?? [],
    revision: story.revision ?? 0,
  };
}

function asJob(record: StoredJob): StoryReconstructionJob {
  const { _id, ...job } = record;
  return { ...job, id: _id };
}

export class MongoStoryRepository {
  private readonly stories: Collection<StoredStory>;
  private readonly jobs: Collection<StoredJob>;

  constructor(private readonly database: Db) {
    this.stories = database.collection<StoredStory>("stories");
    this.jobs = database.collection<StoredJob>("story_reconstruction_jobs");
  }

  async ensureIndexes(): Promise<void> {
    let pending = storyIndexes.get(this.database);
    if (!pending) {
      pending = Promise.all([
        this.stories.createIndex({ groupId: 1, sourceKey: 1 }, { unique: true }),
        this.stories.createIndex({ groupId: 1, contextKey: 1 }, { unique: true }),
        this.stories.createIndex({ groupId: 1, status: 1, startAt: -1 }),
        this.jobs.createIndex({ groupId: 1, requestId: 1 }, { unique: true }),
        this.jobs.createIndex({ groupId: 1, createdAt: -1 }),
      ]).then(() => undefined);
      storyIndexes.set(this.database, pending);
    }
    try {
      await pending;
    } catch (error) {
      storyIndexes.delete(this.database);
      throw error;
    }
  }

  async insertStoryIfAbsent(story: Story): Promise<Story> {
    await this.ensureIndexes();
    const { id, ...document } = story;
    try {
      await this.stories.updateOne(
        { groupId: story.groupId, sourceKey: story.sourceKey },
        { $setOnInsert: { _id: id, ...document } },
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
    const saved = await this.stories.findOne({
      groupId: story.groupId,
      sourceKey: story.sourceKey,
    }) ?? await this.stories.findOne({
      groupId: story.groupId,
      contextKey: story.contextKey,
    });
    if (!saved) throw new Error("Story could not be read after idempotent insert");
    return asStory(saved);
  }

  async findStory(groupId: string, storyId: string): Promise<Story | null> {
    await this.ensureIndexes();
    const record = await this.stories.findOne({ _id: storyId, groupId });
    return record ? asStory(record) : null;
  }

  async findStoryByContextKey(groupId: string, contextKey: string): Promise<Story | null> {
    await this.ensureIndexes();
    const record = await this.stories.findOne({ groupId, contextKey });
    return record ? asStory(record) : null;
  }

  async listStories(groupId: string, limit = 50): Promise<Story[]> {
    await this.ensureIndexes();
    const records = await this.stories.find({ groupId })
      .sort({ startAt: -1 })
      .limit(limit)
      .toArray();
    return records.map(asStory);
  }

  async reviewStory(input: {
    groupId: string;
    storyId: string;
    actorUserId: string;
    action: "confirm" | "reject";
    expectedRevision: number;
  }): Promise<Story | null> {
    await this.ensureIndexes();
    const story = await this.stories.findOne({
      _id: input.storyId,
      groupId: input.groupId,
      status: "candidate",
      revision: input.expectedRevision,
    });
    if (!story) return null;
    const afterStatus = input.action === "confirm" ? "confirmed" : "rejected";
    const occurredAt = new Date();
    const event: StoryReviewEvent = {
      id: randomUUID(),
      actorUserId: input.actorUserId,
      action: input.action,
      occurredAt,
      beforeStatus: "candidate",
      afterStatus,
    };
    const result = await this.stories.updateOne(
      {
        _id: input.storyId,
        groupId: input.groupId,
        status: "candidate",
        revision: input.expectedRevision,
      },
      {
        $set: {
          status: afterStatus,
          ...(input.action === "confirm"
            ? {
                uncertaintyLabel: "confirmed",
                uncertaintyReason: "A group member explicitly confirmed this recurring story connection.",
              }
            : {}),
          updatedAt: occurredAt,
        },
        $inc: { revision: 1 },
        $push: { reviewHistory: { $each: [event] } },
      },
    );
    if (result.modifiedCount !== 1) return null;
    return this.findStory(input.groupId, input.storyId);
  }

  async createStoryJob(input: {
    groupId: string;
    requesterUserId: string;
    requestId: string;
  }): Promise<StoryReconstructionJob> {
    await this.ensureIndexes();
    const now = new Date();
    const jobId = randomUUID();
    await this.jobs.updateOne(
      { groupId: input.groupId, requestId: input.requestId },
      {
        $setOnInsert: {
          _id: jobId,
          groupId: input.groupId,
          requesterUserId: input.requesterUserId,
          requestId: input.requestId,
          status: "queued",
          workflowId: null,
          storyId: null,
          outcome: null,
          errorCategory: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    const record = await this.jobs.findOne({
      groupId: input.groupId,
      requestId: input.requestId,
    });
    if (!record) throw new Error("Story reconstruction job could not be read after upsert");
    return asJob(record);
  }

  async findStoryJob(groupId: string, jobId: string): Promise<StoryReconstructionJob | null> {
    await this.ensureIndexes();
    const record = await this.jobs.findOne({ _id: jobId, groupId });
    return record ? asJob(record) : null;
  }

  async listPendingStoryJobs(
    groupId: string,
    requesterUserId: string,
  ): Promise<StoryReconstructionJob[]> {
    await this.ensureIndexes();
    const records = await this.jobs.find({
      groupId,
      requesterUserId,
      status: { $in: ["queued", "running"] },
    }).sort({ createdAt: -1 }).limit(5).toArray();
    return records.map(asJob);
  }

  async markStoryJobStarted(input: { groupId: string; jobId: string; workflowId: string }): Promise<void> {
    await this.ensureIndexes();
    await this.jobs.updateOne(
      { _id: input.jobId, groupId: input.groupId, status: "queued" },
      { $set: { status: "running", workflowId: input.workflowId, updatedAt: new Date() } },
    );
  }

  async markStoryJobSucceeded(input: {
    groupId: string;
    jobId: string;
    storyId: string | null;
    outcome: "candidate" | "insufficient_evidence";
  }): Promise<void> {
    await this.ensureIndexes();
    await this.jobs.updateOne(
      { _id: input.jobId, groupId: input.groupId },
      {
        $set: {
          status: "succeeded",
          storyId: input.storyId,
          outcome: input.outcome,
          errorCategory: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  async markStoryJobFailed(input: {
    groupId: string;
    jobId: string;
    errorCategory: string;
  }): Promise<void> {
    await this.ensureIndexes();
    await this.jobs.updateOne(
      { _id: input.jobId, groupId: input.groupId },
      {
        $set: {
          status: "failed",
          errorCategory: input.errorCategory,
          updatedAt: new Date(),
        },
      },
    );
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.ensureIndexes();
    await Promise.all([
      this.stories.deleteMany({ groupId }),
      this.jobs.deleteMany({ groupId }),
    ]);
  }
}
