import { randomUUID } from "node:crypto";
import type { Collection, Db, Document } from "mongodb";

const JOB_COLLECTIONS = [
  "processing_jobs",
  "story_reconstruction_jobs",
  "event_story_generation_jobs",
  "event_story_audio_jobs",
] as const;

type JobCollection = (typeof JOB_COLLECTIONS)[number];

export interface ClaimedBackgroundJob {
  collection: JobCollection;
  id: string;
  groupId: string;
  jobType?: "ingest" | "delete_fragment" | "reconstruct_moment" | "transcribe_voice";
  fragmentId?: string;
  requesterUserId?: string;
  storyRevision?: number;
  workerLeaseId: string;
  attemptCount: number;
}

interface StoredJob extends Document {
  _id: string;
  groupId: string;
  status: string;
  jobType?: ClaimedBackgroundJob["jobType"];
  fragmentId?: string;
  requesterUserId?: string;
  storyRevision?: number;
  attemptCount?: number;
}

const LEASE_DURATION_MS = 15 * 60 * 1000;
const LEGACY_RUNNING_STALE_MS = 15 * 60 * 1000;

export class MongoBackgroundJobQueue {
  private readonly collections: Record<JobCollection, Collection<StoredJob>>;

  constructor(private readonly database: Db) {
    this.collections = {
      processing_jobs: database.collection<StoredJob>("processing_jobs"),
      story_reconstruction_jobs: database.collection<StoredJob>("story_reconstruction_jobs"),
      event_story_generation_jobs: database.collection<StoredJob>("event_story_generation_jobs"),
      event_story_audio_jobs: database.collection<StoredJob>("event_story_audio_jobs"),
    };
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all(JOB_COLLECTIONS.map((name) =>
      this.collections[name].createIndex({ status: 1, createdAt: 1 }),
    ));
  }

  async claimNext(workerId: string): Promise<ClaimedBackgroundJob | null> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - LEGACY_RUNNING_STALE_MS);
    for (const name of JOB_COLLECTIONS) {
      const leaseId = `${workerId}:${randomUUID()}`;
      const claimed = await this.collections[name].findOneAndUpdate(
        {
          $or: [
            { status: { $in: ["queued", "retrying"] } },
            { status: "running", workerLeaseUntil: { $lte: now } },
            {
              status: "running",
              workerLeaseUntil: { $exists: false },
              updatedAt: { $lte: staleBefore },
            },
          ],
        },
        {
          $set: {
            status: "running",
            workerLeaseId: leaseId,
            workerLeaseUntil: new Date(now.getTime() + LEASE_DURATION_MS),
            workflowId: `mongodb-worker:${leaseId}`,
            updatedAt: now,
          },
          $inc: { attemptCount: 1 },
        },
        { sort: { createdAt: 1 }, returnDocument: "after" },
      );
      if (!claimed) continue;
      return {
        collection: name,
        id: String(claimed._id),
        groupId: String(claimed.groupId),
        ...(claimed.jobType ? { jobType: claimed.jobType } : {}),
        ...(claimed.fragmentId ? { fragmentId: String(claimed.fragmentId) } : {}),
        ...(claimed.requesterUserId ? { requesterUserId: String(claimed.requesterUserId) } : {}),
        ...(typeof claimed.storyRevision === "number" ? { storyRevision: claimed.storyRevision } : {}),
        workerLeaseId: leaseId,
        attemptCount: typeof claimed.attemptCount === "number" ? claimed.attemptCount : 1,
      };
    }
    return null;
  }

  async extendLease(job: ClaimedBackgroundJob): Promise<boolean> {
    const result = await this.collections[job.collection].updateOne(
      { _id: job.id, status: "running", workerLeaseId: job.workerLeaseId },
      { $set: { workerLeaseUntil: new Date(Date.now() + LEASE_DURATION_MS) } },
    );
    return result.modifiedCount === 1;
  }

  async release(job: ClaimedBackgroundJob): Promise<void> {
    await this.collections[job.collection].updateOne(
      { _id: job.id, workerLeaseId: job.workerLeaseId },
      { $unset: { workerLeaseId: "", workerLeaseUntil: "" } },
    );
  }
}
