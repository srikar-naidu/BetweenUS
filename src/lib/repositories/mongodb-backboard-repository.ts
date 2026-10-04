import type { Collection, Db, Document, Filter } from "mongodb";

export type BackboardIntegrationStatus = "creating" | "enabled" | "disabling" | "disabled" | "failed";
export type BackboardMemoryStatus = "queued" | "running" | "pending" | "synced" | "deleting" | "failed";

export interface GroupBackboardIntegration {
  groupId: string;
  assistantId: string | null;
  status: BackboardIntegrationStatus;
  enabledByUserId: string | null;
  updatedAt: Date;
}

export interface BackboardMemoryLink {
  id: string;
  groupId: string;
  momentId: string;
  correctionId: string;
  fragmentId: string;
  correctionType: "person" | "place" | "reference";
  content: string;
  memoryId: string | null;
  operationId: string | null;
  operationKind: "add" | "delete" | null;
  status: BackboardMemoryStatus;
  updatedAt: Date;
}

type Stored<T> = Omit<T, "id"> & { _id: string } & Document;

function errorCode(error: unknown): number | null {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "number"
    ? error.code
    : null;
}

function asLink(record: Stored<BackboardMemoryLink>): BackboardMemoryLink {
  const { _id, ...link } = record;
  return { ...link, id: _id };
}

const globalForBackboardIndexes = globalThis as typeof globalThis & {
  betweenUsBackboardIndexes?: WeakMap<Db, Promise<void>>;
};
const backboardIndexes = (globalForBackboardIndexes.betweenUsBackboardIndexes ??= new WeakMap());

export class MongoBackboardRepository {
  private readonly integrations: Collection<Stored<GroupBackboardIntegration>>;
  private readonly memories: Collection<Stored<BackboardMemoryLink>>;

  constructor(private readonly database: Db) {
    this.integrations = database.collection("group_backboard_integrations");
    this.memories = database.collection("group_backboard_memories");
  }

  async ensureIndexes(): Promise<void> {
    let pending = backboardIndexes.get(this.database);
    if (!pending) {
      pending = Promise.all([
        this.memories.createIndex({ groupId: 1, correctionId: 1 }, { unique: true }),
        this.memories.createIndex({ groupId: 1, momentId: 1, status: 1 }),
        this.memories.createIndex({ memoryId: 1 }, { sparse: true }),
      ]).then(() => undefined);
      backboardIndexes.set(this.database, pending);
    }
    try {
      await pending;
    } catch (error) {
      backboardIndexes.delete(this.database);
      throw error;
    }
  }

  async findIntegration(groupId: string): Promise<GroupBackboardIntegration | null> {
    const record = await this.integrations.findOne({ _id: groupId });
    if (!record) return null;
    const { _id, ...integration } = record;
    return { ...integration, groupId: _id };
  }

  async claimEnable(groupId: string, userId: string): Promise<"claimed" | "enabled" | "busy"> {
    const current = await this.findIntegration(groupId);
    if (current?.status === "enabled" && current.assistantId) return "enabled";
    if (current?.status === "disabling") return "busy";
    const now = new Date();
    if (current?.status === "creating" && now.getTime() - current.updatedAt.getTime() < 5 * 60_000) {
      return "busy";
    }
    if (!current) {
      try {
        await this.integrations.insertOne({
          _id: groupId,
          groupId,
          assistantId: null,
          status: "creating",
          enabledByUserId: userId,
          updatedAt: now,
        });
        return "claimed";
      } catch (error) {
        if (errorCode(error) !== 11000) throw error;
        return "busy";
      }
    }
    const result = await this.integrations.updateOne(
      { _id: groupId, status: current.status, updatedAt: current.updatedAt },
      {
        $set: {
          assistantId: null,
          status: "creating",
          enabledByUserId: userId,
          updatedAt: now,
        },
      },
    );
    return result.modifiedCount === 1 ? "claimed" : "busy";
  }

  async completeEnable(groupId: string, userId: string, assistantId: string): Promise<void> {
    const result = await this.integrations.updateOne(
      { _id: groupId, status: "creating" },
      {
        $set: {
          assistantId,
          status: "enabled",
          enabledByUserId: userId,
          updatedAt: new Date(),
        },
      },
    );
    if (result.modifiedCount !== 1) throw new Error("Backboard group opt-in changed while provisioning");
  }

  async failEnable(groupId: string, assistantId: string | null = null): Promise<void> {
    await this.integrations.updateOne(
      { _id: groupId, status: "creating" },
      {
        $set: {
          assistantId,
          status: assistantId ? "disabling" : "failed",
          updatedAt: new Date(),
        },
      },
    );
  }

  async updateIntegrationStatus(
    groupId: string,
    status: BackboardIntegrationStatus,
  ): Promise<void> {
    await this.integrations.updateOne(
      { _id: groupId },
      { $set: { status, updatedAt: new Date() } },
    );
  }

  async beginDisable(groupId: string): Promise<GroupBackboardIntegration | null> {
    const integration = await this.findIntegration(groupId);
    if (!integration || integration.status === "disabled") return integration;
    if (integration.status !== "enabled" || !integration.assistantId) return null;
    const result = await this.integrations.updateOne(
      { _id: groupId, status: "enabled", assistantId: integration.assistantId },
      { $set: { status: "disabling", updatedAt: new Date() } },
    );
    return result.modifiedCount === 1
      ? { ...integration, status: "disabling" }
      : null;
  }

  async completeDisable(groupId: string): Promise<void> {
    await this.memories.deleteMany({ groupId });
    await this.integrations.updateOne(
      { _id: groupId, status: "disabling" },
      {
        $set: {
          assistantId: null,
          status: "disabled",
          enabledByUserId: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  async deleteGroupData(groupId: string): Promise<void> {
    await Promise.all([
      this.memories.deleteMany({ groupId }),
      this.integrations.deleteOne({ _id: groupId }),
    ]);
  }

  async upsertMemoryLink(input: Omit<BackboardMemoryLink, "id" | "updatedAt">): Promise<void> {
    await this.ensureIndexes();
    const id = `${input.groupId}:${input.correctionId}`;
    await this.memories.updateOne(
      { _id: id, groupId: input.groupId, correctionId: input.correctionId },
      {
        $set: { ...input, updatedAt: new Date() },
        $setOnInsert: { _id: id },
      },
      { upsert: true },
    );
  }

  async claimNewMemoryLink(input: Omit<BackboardMemoryLink, "id" | "updatedAt">): Promise<boolean> {
    await this.ensureIndexes();
    const id = `${input.groupId}:${input.correctionId}`;
    try {
      await this.memories.insertOne({ _id: id, ...input, updatedAt: new Date() });
      return true;
    } catch (error) {
      if (errorCode(error) === 11000) return false;
      throw error;
    }
  }

  async claimPendingMemoryOperation(input: {
    groupId: string;
    correctionId: string;
    operationId: string;
    operationKind: "add" | "delete";
  }): Promise<boolean> {
    await this.ensureIndexes();
    const result = await this.memories.updateOne(
      {
        groupId: input.groupId,
        correctionId: input.correctionId,
        operationId: input.operationId,
        operationKind: input.operationKind,
        $or: [
          { status: { $in: ["pending", "failed"] } },
          { status: "running", updatedAt: { $lt: new Date(Date.now() - 5 * 60_000) } },
        ],
      },
      { $set: { status: "running", updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  async claimMemoryDeletion(input: {
    groupId: string;
    correctionId: string;
    operationId?: string;
  }): Promise<boolean> {
    await this.ensureIndexes();
    const now = new Date();
    const operationFilter: Filter<Stored<BackboardMemoryLink>> = input.operationId
      ? { operationId: input.operationId, operationKind: "delete" }
      : {
          $or: [
            { operationKind: { $ne: "delete" } },
            { operationKind: "delete", operationId: null },
          ],
        };
    const result = await this.memories.updateOne(
      {
        groupId: input.groupId,
        correctionId: input.correctionId,
        $and: [
          operationFilter,
          {
            $or: [
              { status: { $in: ["synced", "pending", "failed"] } },
              {
                status: { $in: ["deleting", "running"] },
                updatedAt: { $lt: new Date(now.getTime() - 5 * 60_000) },
              },
            ],
          },
        ],
      },
      { $set: { status: "deleting", updatedAt: now } },
    );
    return result.modifiedCount === 1;
  }

  async findMemoryLink(groupId: string, correctionId: string): Promise<BackboardMemoryLink | null> {
    await this.ensureIndexes();
    const record = await this.memories.findOne({ groupId, correctionId });
    return record ? asLink(record) : null;
  }

  async findMemoryLinksForMoment(groupId: string, momentId: string): Promise<BackboardMemoryLink[]> {
    await this.ensureIndexes();
    const records = await this.memories.find({ groupId, momentId }).toArray();
    return records.map(asLink);
  }

  async listMemoryLinks(groupId: string): Promise<BackboardMemoryLink[]> {
    await this.ensureIndexes();
    const records = await this.memories.find({ groupId }).toArray();
    return records.map(asLink);
  }

  async findMemoryLinksForFragment(groupId: string, fragmentId: string): Promise<BackboardMemoryLink[]> {
    await this.ensureIndexes();
    const records = await this.memories.find({ groupId, fragmentId }).toArray();
    return records.map(asLink);
  }

  async findSyncedMemoryIds(groupId: string, memoryIds: readonly string[]): Promise<BackboardMemoryLink[]> {
    await this.ensureIndexes();
    if (!memoryIds.length) return [];
    const records = await this.memories.find({
      groupId,
      memoryId: { $in: [...memoryIds] },
      status: "synced",
    }).toArray();
    return records.map(asLink);
  }

  async deleteMemoryLink(groupId: string, correctionId: string): Promise<void> {
    await this.memories.deleteOne({ groupId, correctionId });
  }

  async updateMemoryState(input: {
    groupId: string;
    correctionId: string;
    status: BackboardMemoryStatus;
    operationId?: string | null;
    operationKind?: "add" | "delete" | null;
    memoryId?: string | null;
  }): Promise<void> {
    await this.memories.updateOne(
      { groupId: input.groupId, correctionId: input.correctionId },
      {
        $set: {
          status: input.status,
          ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
          ...(input.operationKind !== undefined ? { operationKind: input.operationKind } : {}),
          ...(input.memoryId !== undefined ? { memoryId: input.memoryId } : {}),
          updatedAt: new Date(),
        },
      },
    );
  }
}
