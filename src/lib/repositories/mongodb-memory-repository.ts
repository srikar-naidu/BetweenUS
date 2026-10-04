import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import type { Collection, Db, Filter } from "mongodb";
import type { ClientSession } from "mongodb";
import type {
  Fragment,
  Moment,
  MomentReviewEvent,
  NewFragment,
  NewMoment,
} from "@/lib/domain/memory";

type FragmentDocument = Omit<Fragment, "id"> & { _id: string };
type MomentDocument = Omit<Moment, "id"> & { _id: string };

function asFragment(document: FragmentDocument): Fragment {
  const { _id, ...fragment } = document;
  return {
    ...fragment,
    id: _id,
    textContent: fragment.textContent ?? null,
    source: fragment.source ?? "legacy",
    capturedTimeZone: fragment.capturedTimeZone ?? null,
    checksumSha256: fragment.checksumSha256 ?? null,
    processingVersion: fragment.processingVersion ?? "legacy",
  };
}

function asMoment(document: MomentDocument): Moment {
  const { _id, ...moment } = document;
  return {
    ...moment,
    id: _id,
    reviewHistory: moment.reviewHistory ?? [],
    corrections: (moment.corrections ?? []).map((correction, index) => ({
      ...correction,
      id: correction.id ?? `legacy-${_id}-${index}`,
    })),
    revision: moment.revision ?? 0,
    mergedIntoMomentId: moment.mergedIntoMomentId ?? null,
  };
}

function expectedRevisionFilter(revision: number): Filter<MomentDocument> {
  return revision === 0
    ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
    : { revision };
}

export class MomentReviewConflictError extends Error {
  constructor() {
    super("Moment changed while the review action was being saved");
    this.name = "MomentReviewConflictError";
  }
}

export class MongoMemoryRepository {
  private readonly database: Db;
  private readonly fragments: Collection<FragmentDocument>;
  private readonly moments: Collection<MomentDocument>;

  constructor(database: Db) {
    this.database = database;
    this.fragments = database.collection<FragmentDocument>("fragments");
    this.moments = database.collection<MomentDocument>("moments");
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.fragments.createIndex({ groupId: 1, visibility: 1, capturedAt: -1 }),
      this.fragments.createIndex({ groupId: 1, authorUserId: 1, capturedAt: -1 }),
      this.moments.createIndex({ groupId: 1, startAt: -1 }),
      this.moments.createIndex({ groupId: 1, status: 1, startAt: -1 }),
    ]);
  }

  async createFragment(input: NewFragment): Promise<Fragment> {
    const now = new Date();
    const { id, ...fields } = input;
    const aiProcessingConsent = input.aiProcessingConsent === true;
    const fragment: FragmentDocument = {
      _id: id ?? randomUUID(),
      ...fields,
      storageUri: input.storageUri ?? null,
      caption: input.caption ?? null,
      textContent: input.textContent ?? null,
      source: input.source ?? "legacy",
      capturedTimeZone: input.capturedTimeZone ?? null,
      checksumSha256: input.checksumSha256 ?? null,
      processingVersion: input.processingVersion ?? "ingest-v1",
      metadata: input.metadata ?? {},
      visibility: input.visibility ?? "private",
      aiProcessingConsent,
      aiProcessingConsentAt: aiProcessingConsent ? now : null,
      aiProcessingConsentRevokedAt: null,
      transcriptionConsent: input.transcriptionConsent === true,
      transcriptionConsentAt: input.transcriptionConsent === true ? now : null,
      transcriptionConsentRevokedAt: null,
      transcriptReviewedAt: null,
      deletionState: "active",
      deletionRequestedAt: null,
      deletionRequestedByUserId: null,
      status: "uploaded",
      createdAt: now,
    };
    try {
      await this.fragments.insertOne(fragment);
    } catch (error) {
      if (id && typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
        const existing = await this.fragments.findOne({
          _id: id,
          groupId: input.groupId,
          authorUserId: input.authorUserId,
        });
        if (existing) return asFragment(existing);
      }
      throw error;
    }
    return asFragment(fragment);
  }

  async upsertFragment(fragment: Fragment): Promise<void> {
    const { id, ...document } = fragment;
    await this.fragments.updateOne(
      { _id: id },
      { $set: document, $setOnInsert: { _id: id } },
      { upsert: true },
    );
  }

  async findFragmentById(groupId: string, fragmentId: string): Promise<Fragment | null> {
    const document = await this.fragments.findOne({ _id: fragmentId, groupId });
    return document ? asFragment(document) : null;
  }

  async findFragmentVisibleToMember(
    groupId: string,
    fragmentId: string,
    userId: string,
  ): Promise<Fragment | null> {
    const document = await this.fragments.findOne({
      _id: fragmentId,
      groupId,
      deletionState: "active",
      $or: [{ visibility: "group" }, { authorUserId: userId }],
    });
    return document ? asFragment(document) : null;
  }

  async findEligibleGroupVisibleFragmentsByIds(
    groupId: string,
    fragmentIds: readonly string[],
  ): Promise<Fragment[]> {
    if (!fragmentIds.length) return [];
    const documents = await this.fragments.find({
      _id: { $in: [...fragmentIds] },
      groupId,
      visibility: "group",
      aiProcessingConsent: true,
      deletionState: "active",
      $or: [
        { type: "text", source: "text" },
        { type: "voice", source: "upload", transcriptReviewedAt: { $type: "date" } },
        {
          type: { $in: ["image", "video"] },
          source: "upload",
          checksumSha256: { $type: "string" },
          storageUri: { $type: "string" },
        },
      ],
    }).toArray();
    return documents.map(asFragment);
  }

  async updateFragmentStatus(
    groupId: string,
    fragmentId: string,
    status: Fragment["status"],
  ): Promise<void> {
    await this.fragments.updateOne(
      { _id: fragmentId, groupId, deletionState: "active" },
      { $set: { status, updatedAt: new Date() } },
    );
  }

  async reviewVoiceTranscript(input: {
    groupId: string;
    fragmentId: string;
    authorUserId: string;
    transcript: string;
    visibility: Fragment["visibility"];
    aiProcessingConsent: boolean;
    processingVersion: string;
  }, session?: ClientSession): Promise<Fragment | null> {
    const now = new Date();
    const result = await this.fragments.updateOne(
      {
        _id: input.fragmentId,
        groupId: input.groupId,
        authorUserId: input.authorUserId,
        type: "voice",
        source: "upload",
        deletionState: "active",
      },
      {
        $set: {
          textContent: input.transcript,
          visibility: input.visibility,
          aiProcessingConsent: input.aiProcessingConsent,
          aiProcessingConsentAt: input.aiProcessingConsent ? now : null,
          aiProcessingConsentRevokedAt: null,
          transcriptReviewedAt: now,
          processingVersion: input.processingVersion,
          updatedAt: now,
        },
      },
      { session },
    );
    if (result.matchedCount !== 1) return null;
    const document = await this.fragments.findOne({
      _id: input.fragmentId,
      groupId: input.groupId,
      authorUserId: input.authorUserId,
      deletionState: "active",
    }, { session });
    return document ? asFragment(document) : null;
  }

  async findGroupVisibleFragments(
    groupId: string,
    startAt: Date,
    endAt: Date,
    limit = 50,
  ): Promise<Fragment[]> {
    const query: Filter<FragmentDocument> = {
      groupId,
      visibility: "group",
      aiProcessingConsent: true,
      deletionState: "active",
      $or: [
        { type: "text", source: "text" },
        { type: "voice", source: "upload", transcriptReviewedAt: { $type: "date" } },
        {
          type: { $in: ["image", "video"] },
          source: "upload",
          checksumSha256: { $type: "string" },
          storageUri: { $type: "string" },
        },
      ],
      capturedAt: { $gte: startAt, $lte: endAt },
    };
    const documents = await this.fragments
      .find(query)
      .sort({ capturedAt: 1 })
      .limit(limit)
      .toArray();
    return documents.map(asFragment);
  }

  async findMemberVisibleFragments(
    groupId: string,
    userId: string,
    limit = 100,
  ): Promise<Fragment[]> {
    const documents = await this.fragments
      .find({
        groupId,
        deletionState: "active",
        $or: [{ visibility: "group" }, { authorUserId: userId }],
      })
      .sort({ capturedAt: -1 })
      .limit(limit)
      .toArray();
    return documents.map(asFragment);
  }

  async findRecentGroupVisibleFragments(groupId: string, limit = 100): Promise<Fragment[]> {
    const documents = await this.fragments
      .find({ groupId, visibility: "group", deletionState: "active" })
      .sort({ capturedAt: -1 })
      .limit(limit)
      .toArray();
    return documents.map(asFragment);
  }

  async updateFragmentPrivacy(input: {
    groupId: string;
    fragmentId: string;
    authorUserId: string;
    visibility: Fragment["visibility"];
    aiProcessingConsent: boolean;
    processingVersion?: string;
  }): Promise<Fragment | null> {
    const now = new Date();
    const existing = await this.fragments.findOne({
      _id: input.fragmentId,
      groupId: input.groupId,
      authorUserId: input.authorUserId,
      deletionState: "active",
    });
    if (!existing) return null;
    const consentUpdate: Record<string, unknown> = {
      visibility: input.visibility,
      aiProcessingConsent: input.aiProcessingConsent,
    };
    if (input.processingVersion) consentUpdate.processingVersion = input.processingVersion;
    if (existing.aiProcessingConsent !== input.aiProcessingConsent) {
      if (input.aiProcessingConsent) {
        consentUpdate.aiProcessingConsentAt = now;
        consentUpdate.aiProcessingConsentRevokedAt = null;
      } else {
        consentUpdate.aiProcessingConsentRevokedAt = now;
      }
    }
    await this.fragments.updateOne(
      {
        _id: input.fragmentId,
        groupId: input.groupId,
        authorUserId: input.authorUserId,
        deletionState: "active",
      },
      { $set: consentUpdate },
    );
    const document = await this.fragments.findOne({
      _id: input.fragmentId,
      groupId: input.groupId,
      authorUserId: input.authorUserId,
      deletionState: "active",
    });
    if (
      document &&
      (document.visibility !== "group" || document.aiProcessingConsent !== true)
    ) {
      await this.invalidateMomentsForFragment(input.groupId, input.fragmentId);
    }
    return document ? asFragment(document) : null;
  }

  async invalidateMomentsForFragment(groupId: string, fragmentId: string): Promise<void> {
    await this.moments.updateMany(
      { groupId, "evidence.fragmentId": fragmentId, status: { $in: ["candidate", "confirmed"] } },
      {
        $set: {
          status: "draft",
          uncertaintyLabel: "unknown",
          uncertaintyReason: "A source fragment's visibility or AI consent changed; this moment needs review.",
          updatedAt: new Date(),
        },
      },
    );
  }

  async requestFragmentDeletion(input: {
    groupId: string;
    fragmentId: string;
    actorUserId: string;
    canManageGroup: boolean;
  }): Promise<boolean> {
    const ownershipFilter: Filter<FragmentDocument> = input.canManageGroup
      ? {
          groupId: input.groupId,
          $or: [
            { visibility: "group" },
            { authorUserId: input.actorUserId },
          ],
        }
      : { groupId: input.groupId, authorUserId: input.actorUserId };
    const now = new Date();
    const result = await this.fragments.updateOne(
      { _id: input.fragmentId, deletionState: "active", ...ownershipFilter },
      {
        $set: {
          aiProcessingConsent: false,
          aiProcessingConsentRevokedAt: now,
          transcriptionConsent: false,
          transcriptionConsentRevokedAt: now,
          deletionState: "pending",
          deletionRequestedAt: now,
          deletionRequestedByUserId: input.actorUserId,
        },
      },
    );
    if (result.matchedCount !== 1) return false;
    await this.invalidateMomentsForFragment(input.groupId, input.fragmentId);
    await this.database.collection("deletion_requests").updateOne(
      { targetType: "fragment", targetId: input.fragmentId, status: { $ne: "completed" } },
      {
        $setOnInsert: {
          _id: randomUUID(),
          groupId: input.groupId,
          targetType: "fragment",
          targetId: input.fragmentId,
          requestedByUserId: input.actorUserId,
          status: "pending",
          createdAt: now,
        },
      },
      { upsert: true },
    );
    return true;
  }

  async requestGroupDeletion(input: {
    groupId: string;
    requestedByUserId: string;
  }): Promise<boolean> {
    if (!ObjectId.isValid(input.groupId) || !ObjectId.isValid(input.requestedByUserId)) {
      return false;
    }
    const now = new Date();
    const groups = this.database.collection("groups");
    const result = await groups.updateOne(
      { _id: new ObjectId(input.groupId) },
      {
        $set: {
          lifecycleStatus: "deletion_pending",
          deletionRequestedAt: now,
          deletionRequestedByUserId: input.requestedByUserId,
        },
      },
    );
    if (result.matchedCount !== 1) return false;
    await this.fragments.updateMany(
      { groupId: input.groupId, deletionState: "active" },
      {
        $set: {
          aiProcessingConsent: false,
          aiProcessingConsentRevokedAt: now,
          transcriptionConsent: false,
          transcriptionConsentRevokedAt: now,
          deletionState: "pending",
          deletionRequestedAt: now,
          deletionRequestedByUserId: input.requestedByUserId,
        },
      },
    );
    await this.moments.updateMany(
      { groupId: input.groupId, status: { $in: ["candidate", "confirmed"] } },
      {
        $set: {
          status: "draft",
          uncertaintyLabel: "unknown",
          uncertaintyReason: "The group is pending deletion; moment evidence is unavailable.",
          updatedAt: now,
        },
      },
    );
    await this.database.collection("deletion_requests").updateOne(
      { targetType: "group", targetId: input.groupId, status: { $ne: "completed" } },
      {
        $setOnInsert: {
          _id: randomUUID(),
          groupId: input.groupId,
          targetType: "group",
          targetId: input.groupId,
          requestedByUserId: input.requestedByUserId,
          status: "pending",
          createdAt: now,
        },
      },
      { upsert: true },
    );
    return true;
  }

  async createMoment(input: NewMoment): Promise<Moment> {
    if (input.confidence < 0 || input.confidence > 1) {
      throw new RangeError("Moment confidence must be between 0 and 1");
    }
    if (input.endAt < input.startAt) {
      throw new RangeError("Moment endAt must not be before startAt");
    }

    const now = new Date();
    const moment: MomentDocument = {
      _id: randomUUID(),
      ...input,
      title: input.title ?? null,
      status: input.status ?? "candidate",
      createdAt: now,
      updatedAt: now,
    };
    await this.moments.insertOne(moment);
    return asMoment(moment);
  }

  async upsertMoment(moment: Moment): Promise<Moment> {
    const { id, ...document } = moment;
    await this.moments.updateOne(
      { _id: id },
      { $set: document, $setOnInsert: { _id: id } },
      { upsert: true },
    );
    const stored: MomentDocument = { _id: id, ...document };
    return asMoment(stored);
  }

  async insertMomentIfAbsent(moment: Moment): Promise<Moment> {
    const { id, ...document } = moment;
    await this.moments.updateOne(
      { _id: id },
      { $setOnInsert: { _id: id, ...document } },
      { upsert: true },
    );
    const stored = await this.moments.findOne({ _id: id, groupId: moment.groupId });
    if (!stored) throw new Error("Idempotent Moment result could not be read");
    return asMoment(stored);
  }

  async reviewMoment(input: {
    groupId: string;
    momentId: string;
    expectedUpdatedAt: Date;
    expectedRevision: number;
    changes: Partial<Pick<
      Moment,
      "title" | "summary" | "status" | "uncertaintyLabel" | "uncertaintyReason" |
      "evidence" | "corrections" | "mergedIntoMomentId"
    >>;
    event: MomentReviewEvent;
  }): Promise<boolean> {
    const result = await this.moments.updateOne(
      {
        _id: input.momentId,
        groupId: input.groupId,
        updatedAt: input.expectedUpdatedAt,
        ...expectedRevisionFilter(input.expectedRevision),
      },
      {
        $set: { ...input.changes, updatedAt: input.event.occurredAt },
        $inc: { revision: 1 },
        $push: { reviewHistory: input.event },
      },
    );
    return result.modifiedCount === 1;
  }

  async mergeMoments(input: {
    groupId: string;
    sourceId: string;
    targetId: string;
    sourceUpdatedAt: Date;
    targetUpdatedAt: Date;
    sourceRevision: number;
    targetRevision: number;
    sourceChanges: Partial<Pick<Moment, "status" | "uncertaintyLabel" | "uncertaintyReason" | "mergedIntoMomentId">>;
    targetChanges: Partial<Pick<
      Moment,
      "evidence" | "startAt" | "endAt" | "corrections" | "status" |
      "uncertaintyLabel" | "uncertaintyReason"
    >>;
    sourceEvent: MomentReviewEvent;
    targetEvent: MomentReviewEvent;
  }): Promise<void> {
    const session = this.database.client.startSession();
    try {
      await session.withTransaction(async () => {
        const source = await this.moments.updateOne(
          {
            _id: input.sourceId,
            groupId: input.groupId,
            updatedAt: input.sourceUpdatedAt,
            ...expectedRevisionFilter(input.sourceRevision),
          },
          {
            $set: { ...input.sourceChanges, updatedAt: input.sourceEvent.occurredAt },
            $inc: { revision: 1 },
            $push: { reviewHistory: input.sourceEvent },
          },
          { session },
        );
        if (source.modifiedCount !== 1) throw new MomentReviewConflictError();
        const target = await this.moments.updateOne(
          {
            _id: input.targetId,
            groupId: input.groupId,
            updatedAt: input.targetUpdatedAt,
            ...expectedRevisionFilter(input.targetRevision),
          },
          {
            $set: { ...input.targetChanges, updatedAt: input.targetEvent.occurredAt },
            $inc: { revision: 1 },
            $push: { reviewHistory: input.targetEvent },
          },
          { session },
        );
        if (target.modifiedCount !== 1) throw new MomentReviewConflictError();
      });
    } finally {
      await session.endSession();
    }
  }

  async findMoment(groupId: string, momentId: string): Promise<Moment | null> {
    const document = await this.moments.findOne({ _id: momentId, groupId });
    return document ? asMoment(document) : null;
  }

  async listMoments(groupId: string, limit = 50): Promise<Moment[]> {
    const documents = await this.moments
      .find({ groupId })
      .sort({ startAt: -1 })
      .limit(limit)
      .toArray();
    return documents.map(asMoment);
  }

  async findLinkedMomentIds(groupId: string, fragmentId: string): Promise<string[]> {
    const moments = await this.moments.find({
      groupId,
      "evidence.fragmentId": fragmentId,
      status: { $in: ["candidate", "confirmed"] },
    }).project({ _id: 1 }).toArray();
    return moments.map((moment) => String(moment._id));
  }

  async findMomentIdsContainingEvidence(groupId: string, fragmentId: string): Promise<string[]> {
    const moments = await this.moments.find({
      groupId,
      "evidence.fragmentId": fragmentId,
    }).project({ _id: 1 }).toArray();
    return moments.map((moment) => String(moment._id));
  }
}