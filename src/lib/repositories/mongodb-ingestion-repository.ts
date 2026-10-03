import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import type { Collection, Db, Document } from "mongodb";
import type { Fragment, FragmentType, FragmentVisibility } from "@/lib/domain/memory";

export type UploadReservationStatus = "issued" | "completed" | "rejected";
export type ProcessingJobStatus = "queued" | "running" | "succeeded" | "failed" | "retrying";

export interface UploadReservation {
  id: string;
  groupId: string;
  authorUserId: string;
  objectKey: string;
  type: Extract<FragmentType, "image" | "screenshot" | "video">;
  contentType: string;
  expectedSize: number;
  capturedAt: Date;
  capturedTimeZone: string;
  visibility: FragmentVisibility;
  aiProcessingConsent: boolean;
  caption: string | null;
  expiresAt: Date;
  status: UploadReservationStatus;
  fragmentId: string | null;
  createdAt: Date;
}

export interface ProcessingJob {
  id: string;
  groupId: string;
  fragmentId: string;
  jobType: "ingest" | "delete_fragment";
  processingVersion: string;
  status: ProcessingJobStatus;
  attemptCount: number;
  temporalWorkflowId: string | null;
  inputRef: string;
  outputRef: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type StoredRecord<T> = Omit<T, "id"> & { _id: string } & Document;

const globalForIngestionIndexes = globalThis as typeof globalThis & {
  betweenUsIngestionIndexes?: WeakMap<Db, Promise<void>>;
};
const ingestionIndexes = (globalForIngestionIndexes.betweenUsIngestionIndexes ??= new WeakMap());

function asRecord<T>(record: StoredRecord<T>): T {
  const { _id, ...value } = record;
  return { ...value, id: _id } as T;
}

export class MongoIngestionRepository {
  private readonly uploadSessions: Collection<StoredRecord<UploadReservation>>;
  private readonly processingJobs: Collection<StoredRecord<ProcessingJob>>;
  private readonly fragments: Collection<StoredRecord<Fragment>>;

  constructor(private readonly database: Db) {
    this.uploadSessions = database.collection<StoredRecord<UploadReservation>>("upload_sessions");
    this.processingJobs = database.collection<StoredRecord<ProcessingJob>>("processing_jobs");
    this.fragments = database.collection<StoredRecord<Fragment>>("fragments");
  }

  async ensureIndexes(): Promise<void> {
    let pending = ingestionIndexes.get(this.database);
    if (!pending) {
      pending = Promise.all([
      this.uploadSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.uploadSessions.createIndex({ groupId: 1, authorUserId: 1, status: 1 }),
      this.processingJobs.createIndex(
        { groupId: 1, fragmentId: 1, jobType: 1, processingVersion: 1 },
        { unique: true },
      ),
      this.processingJobs.createIndex({ status: 1, updatedAt: 1 }),
      ]).then(() => undefined);
      ingestionIndexes.set(this.database, pending);
    }
    try {
      await pending;
    } catch (error) {
      ingestionIndexes.delete(this.database);
      throw error;
    }
  }

  async createUploadReservation(input: Omit<UploadReservation, "id"> & { id?: string }): Promise<UploadReservation> {
    await this.ensureIndexes();
    const reservation: UploadReservation = { ...input, id: input.id ?? randomUUID() };
    const { id, ...document } = reservation;
    try {
      await this.uploadSessions.insertOne({ _id: id, ...document });
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 11000) {
        throw error;
      }
      const existing = await this.uploadSessions.findOne({
        _id: id,
        groupId: reservation.groupId,
        authorUserId: reservation.authorUserId,
      });
      if (!existing) throw error;
      return asRecord(existing);
    }
    return reservation;
  }

  async findUploadReservation(input: {
    groupId: string;
    authorUserId: string;
    uploadId: string;
  }): Promise<UploadReservation | null> {
    await this.ensureIndexes();
    const record = await this.uploadSessions.findOne({
        _id: input.uploadId,
        groupId: input.groupId,
        authorUserId: input.authorUserId,
      });
    return record ? asRecord(record) : null;
  }

  async completeUploadReservation(input: {
    groupId: string;
    authorUserId: string;
    uploadId: string;
    fragmentId: string;
  }): Promise<boolean> {
    await this.ensureIndexes();
    const result = await this.uploadSessions.updateOne(
      {
        _id: input.uploadId,
        groupId: input.groupId,
        authorUserId: input.authorUserId,
        status: "issued",
        expiresAt: { $gt: new Date() },
      },
      { $set: { status: "completed", fragmentId: input.fragmentId, completedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  async rejectUploadReservation(input: {
    groupId: string;
    authorUserId: string;
    uploadId: string;
  }): Promise<void> {
    await this.ensureIndexes();
    await this.uploadSessions.updateOne(
      {
        _id: input.uploadId,
        groupId: input.groupId,
        authorUserId: input.authorUserId,
        status: "issued",
      },
      { $set: { status: "rejected", rejectedAt: new Date() } },
    );
  }

  async upsertProcessingJob(input: {
    groupId: string;
    fragmentId: string;
    jobType: ProcessingJob["jobType"];
    processingVersion: string;
  }): Promise<ProcessingJob> {
    await this.ensureIndexes();
    const id = `${input.jobType}:${input.groupId}:${input.fragmentId}:${input.processingVersion}`;
    const now = new Date();
    const setOnInsert: Omit<ProcessingJob, "id"> = {
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      jobType: input.jobType,
      processingVersion: input.processingVersion,
      status: "queued",
      attemptCount: 0,
      temporalWorkflowId: null,
      inputRef: input.fragmentId,
      outputRef: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.processingJobs.updateOne(
      { _id: id, groupId: input.groupId, fragmentId: input.fragmentId },
      { $setOnInsert: { _id: id, ...setOnInsert } },
      { upsert: true },
    );
    const record = await this.processingJobs.findOne({
      _id: id,
      groupId: input.groupId,
      fragmentId: input.fragmentId,
    });
    if (!record) throw new Error("Processing job could not be read after upsert");
    return asRecord(record);
  }

  async markProcessingJobStarted(input: { id: string; workflowId: string }): Promise<void> {
    await this.ensureIndexes();
    await this.processingJobs.updateOne(
      { _id: input.id, status: { $in: ["queued", "retrying"] } },
      {
        $set: {
          status: "running",
          temporalWorkflowId: input.workflowId,
          errorMessage: null,
          updatedAt: new Date(),
        },
        $inc: { attemptCount: 1 },
      },
    );
  }

  async markProcessingJobSucceeded(input: { id: string; outputRef: string }): Promise<void> {
    await this.ensureIndexes();
    await this.processingJobs.updateOne(
      { _id: input.id },
      { $set: { status: "succeeded", outputRef: input.outputRef, errorMessage: null, updatedAt: new Date() } },
    );
  }

  async markProcessingJobFailed(input: { id: string; errorMessage: string }): Promise<void> {
    await this.ensureIndexes();
    await this.processingJobs.updateOne(
      { _id: input.id },
      { $set: { status: "failed", errorMessage: input.errorMessage, updatedAt: new Date() } },
    );
  }

  async resetFailedProcessingJobForRetry(input: {
    groupId: string;
    id: string;
    jobType: ProcessingJob["jobType"];
  }): Promise<boolean> {
    await this.ensureIndexes();
    const result = await this.processingJobs.updateOne(
      { _id: input.id, groupId: input.groupId, status: "failed", jobType: input.jobType },
      {
        $set: {
          status: "queued",
          temporalWorkflowId: null,
          outputRef: null,
          errorMessage: null,
          updatedAt: new Date(),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async findProcessingJob(groupId: string, id: string): Promise<ProcessingJob | null> {
    await this.ensureIndexes();
    const record = await this.processingJobs.findOne({ _id: id, groupId });
    return record ? asRecord(record) : null;
  }

  async latestProcessingStatusByFragmentIds(
    groupId: string,
    fragmentIds: readonly string[],
  ): Promise<Map<string, ProcessingJobStatus>> {
    await this.ensureIndexes();
    if (!fragmentIds.length) return new Map();
    const records = await this.processingJobs.find({
      groupId,
      fragmentId: { $in: [...fragmentIds] },
    }).sort({ updatedAt: -1 }).toArray();
    const statuses = new Map<string, ProcessingJobStatus>();
    for (const record of records) {
      if (!statuses.has(record.fragmentId)) statuses.set(record.fragmentId, record.status);
    }
    return statuses;
  }

  async findFragmentForCleanup(groupId: string, fragmentId: string): Promise<Pick<Fragment, "id" | "groupId" | "source" | "storageUri" | "deletionState"> | null> {
    const record = await this.fragments.findOne({
      _id: fragmentId,
      groupId,
      deletionState: "pending",
    });
    if (!record) return null;
    return {
      id: fragmentId,
      groupId,
      source: record.source === "upload" ? "upload" : "legacy",
      storageUri: typeof record.storageUri === "string" ? record.storageUri : null,
      deletionState: "pending",
    };
  }

  async findActiveUploadedFragments(groupId: string): Promise<Array<Pick<Fragment, "id" | "groupId" | "source" | "processingVersion">>> {
    const records = await this.fragments.find({
      groupId,
      source: "upload",
      deletionState: "active",
    }).project({ _id: 1, groupId: 1, source: 1, processingVersion: 1 }).toArray();
    return records.map((record) => ({
      id: String(record._id),
      groupId: String(record.groupId),
      source: "upload",
      processingVersion: typeof record.processingVersion === "string" ? record.processingVersion : "legacy",
    }));
  }

  async findPendingGroupFragments(groupId: string): Promise<Array<Pick<Fragment, "id" | "groupId" | "source" | "processingVersion">>> {
    const records = await this.fragments.find({ groupId, deletionState: "pending" })
      .project({ _id: 1, groupId: 1, source: 1, processingVersion: 1 })
      .toArray();
    return records.map((record) => ({
      id: String(record._id),
      groupId: String(record.groupId),
      source: record.source === "upload" ? "upload" : "legacy",
      processingVersion: typeof record.processingVersion === "string" ? record.processingVersion : "legacy",
    }));
  }

  async markFragmentDeletionComplete(groupId: string, fragmentId: string): Promise<void> {
    const now = new Date();
    await this.fragments.updateOne(
      { _id: fragmentId, groupId, deletionState: "pending" },
      {
        $set: {
          deletionState: "deleted",
          storageUri: null,
          textContent: null,
          caption: null,
          metadata: {},
          checksumSha256: null,
          aiProcessingConsent: false,
          updatedAt: now,
        },
      },
    );
    await this.database.collection("deletion_requests").updateOne(
      { targetType: "fragment", targetId: fragmentId, groupId, status: "pending" },
      { $set: { status: "completed", completedAt: now } },
    );
    const groupIdAsObjectId = ObjectId.isValid(groupId) ? new ObjectId(groupId) : null;
    if (!groupIdAsObjectId) return;
    await this.completeGroupDeletionIfNoPendingFragments(groupId);
  }

  async completeGroupDeletionIfNoPendingFragments(groupId: string): Promise<void> {
    if (!ObjectId.isValid(groupId)) return;
    const groupIdAsObjectId = new ObjectId(groupId);
    const pendingCount = await this.fragments.countDocuments({ groupId, deletionState: "pending" });
    if (pendingCount !== 0) return;
    const result = await this.database.collection("groups").updateOne(
      { _id: groupIdAsObjectId, lifecycleStatus: "deletion_pending" },
      { $set: { lifecycleStatus: "deleted", deletedAt: new Date() } },
    );
    if (result.matchedCount !== 1) return;
    await this.database.collection("deletion_requests").updateOne(
      { targetType: "group", targetId: groupId, status: "pending" },
      { $set: { status: "completed", completedAt: new Date() } },
    );
  }
}
