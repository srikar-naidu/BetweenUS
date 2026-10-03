import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import type { Collection, Db, Filter } from "mongodb";
import type {
  Fragment,
  Moment,
  NewFragment,
  NewMoment,
} from "@/lib/domain/memory";

type FragmentDocument = Omit<Fragment, "id"> & { _id: string };
type MomentDocument = Omit<Moment, "id"> & { _id: string };

function asFragment(document: FragmentDocument): Fragment {
  const { _id, ...fragment } = document;
  return { ...fragment, id: _id };
}

function asMoment(document: MomentDocument): Moment {
  const { _id, ...moment } = document;
  return { ...moment, id: _id };
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
    const aiProcessingConsent = input.aiProcessingConsent === true;
    const fragment: FragmentDocument = {
      _id: randomUUID(),
      ...input,
      caption: input.caption ?? null,
      metadata: input.metadata ?? {},
      visibility: input.visibility ?? "private",
      aiProcessingConsent,
      aiProcessingConsentAt: aiProcessingConsent ? now : null,
      aiProcessingConsentRevokedAt: null,
      deletionState: "active",
      deletionRequestedAt: null,
      deletionRequestedByUserId: null,
      status: "uploaded",
      createdAt: now,
    };
    await this.fragments.insertOne(fragment);
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

  async updateFragmentPrivacy(input: {
    groupId: string;
    fragmentId: string;
    authorUserId: string;
    visibility: Fragment["visibility"];
    aiProcessingConsent: boolean;
  }): Promise<Fragment | null> {
    const now = new Date();
    const consentUpdate: Record<string, unknown> = {
      visibility: input.visibility,
      aiProcessingConsent: input.aiProcessingConsent,
      aiProcessingConsentRevokedAt: input.aiProcessingConsent ? null : now,
    };
    if (input.aiProcessingConsent) consentUpdate.aiProcessingConsentAt = now;
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
}