import type { ClientSession, Collection, Db, Document } from "mongodb";
import type { VoiceTranscriptResult, VoiceWord } from "@/lib/integrations/elevenlabs-client";

export type VoiceTranscriptStatus = "manual_review" | "transcribing" | "pending_review" | "failed" | "reviewed";

export interface VoiceTranscript {
  groupId: string;
  fragmentId: string;
  authorUserId: string;
  status: VoiceTranscriptStatus;
  transcript: string;
  words: VoiceWord[];
  languageCode: string | null;
  manualReason: "not_consented" | "provider_disabled" | "monthly_limit" | "temporal_unavailable" | null;
  updatedAt: Date;
  reviewedAt: Date | null;
}

type Stored<T> = Omit<T, "id"> & { _id: string } & Document;

interface VoiceUsageDocument extends Document {
  _id: string;
  kind: "reservation" | "monthly_total";
  month?: string;
  seconds?: number;
  reservedSeconds?: number;
  reservedRequests?: number;
}

function errorCode(error: unknown): number | null {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "number"
    ? error.code
    : null;
}

export class MongoVoiceRepository {
  private readonly transcripts: Collection<Stored<VoiceTranscript>>;
  private readonly usage: Collection<VoiceUsageDocument>;

  constructor(private readonly database: Db) {
    this.transcripts = database.collection<Stored<VoiceTranscript>>("voice_transcripts");
    this.usage = database.collection<VoiceUsageDocument>("voice_transcription_usage");
  }

  async createTranscript(input: Omit<VoiceTranscript, "updatedAt" | "reviewedAt">): Promise<void> {
    await this.transcripts.updateOne(
      { _id: input.fragmentId, groupId: input.groupId },
      {
        $setOnInsert: {
          ...input,
          updatedAt: new Date(),
          reviewedAt: null,
        },
      },
      { upsert: true },
    );
  }

  async findTranscript(groupId: string, fragmentId: string): Promise<VoiceTranscript | null> {
    const transcript = await this.transcripts.findOne({ _id: fragmentId, groupId });
    if (!transcript) return null;
    const { _id, ...value } = transcript;
    return value;
  }

  async statusesByFragmentIds(
    groupId: string,
    fragmentIds: readonly string[],
  ): Promise<Map<string, VoiceTranscriptStatus>> {
    if (!fragmentIds.length) return new Map();
    const records = await this.transcripts.find({
      groupId,
      fragmentId: { $in: [...fragmentIds] },
    }).project({ fragmentId: 1, status: 1 }).toArray();
    return new Map(records.map((record) => [record.fragmentId, record.status]));
  }

  async saveTranscriptResult(input: {
    groupId: string;
    fragmentId: string;
    result: VoiceTranscriptResult;
  }): Promise<boolean> {
    const updated = await this.transcripts.updateOne(
      { _id: input.fragmentId, groupId: input.groupId, status: "transcribing" },
      {
        $set: {
          status: "pending_review",
          transcript: input.result.text,
          words: input.result.words,
          languageCode: input.result.languageCode,
          manualReason: null,
          updatedAt: new Date(),
        },
      },
    );
    return updated.modifiedCount === 1;
  }

  async markTranscriptFailed(groupId: string, fragmentId: string): Promise<void> {
    await this.transcripts.updateOne(
      { _id: fragmentId, groupId, status: "transcribing" },
      { $set: { status: "failed", manualReason: null, updatedAt: new Date() } },
    );
  }

  async markTranscriptReviewed(input: {
    groupId: string;
    fragmentId: string;
    authorUserId: string;
  }, session?: ClientSession): Promise<boolean> {
    const result = await this.transcripts.updateOne(
      {
        _id: input.fragmentId,
        groupId: input.groupId,
        authorUserId: input.authorUserId,
        status: { $in: ["manual_review", "pending_review", "failed"] },
      },
      { $set: { status: "reviewed", reviewedAt: new Date(), updatedAt: new Date() } },
      { session },
    );
    return result.modifiedCount === 1;
  }

  async deleteTranscript(groupId: string, fragmentId: string): Promise<void> {
    await this.transcripts.deleteOne({ _id: fragmentId, groupId });
  }

  async deleteGroupTranscripts(groupId: string): Promise<void> {
    await this.transcripts.deleteMany({ groupId });
  }

  async reserveMonthlyUsage(input: {
    fragmentId: string;
    seconds: number;
    monthlySeconds: number;
    monthlyRequests: number;
    now?: Date;
  }): Promise<"reserved" | "already_reserved" | "exhausted"> {
    const now = input.now ?? new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const session = this.database.client.startSession();
    let outcome: "reserved" | "already_reserved" | "exhausted" = "exhausted";
    try {
      await session.withTransaction(async () => {
        const existing = await this.usage.findOne(
          { _id: input.fragmentId, kind: "reservation" },
          { session },
        );
        if (existing) {
          outcome = "already_reserved";
          return;
        }
        const monthDocumentId = `month:${month}`;
        const result = await this.usage.updateOne(
          {
            _id: monthDocumentId,
            $expr: {
              $and: [
                {
                  $lte: [
                    { $add: [{ $ifNull: ["$reservedSeconds", 0] }, input.seconds] },
                    input.monthlySeconds,
                  ],
                },
                {
                  $lt: [
                    { $ifNull: ["$reservedRequests", 0] },
                    input.monthlyRequests,
                  ],
                },
              ],
            },
          },
          {
            $inc: { reservedSeconds: input.seconds, reservedRequests: 1 },
            $setOnInsert: { month, kind: "monthly_total" },
          },
          { upsert: true, session },
        );
        if (result.matchedCount !== 1 && result.upsertedCount !== 1) {
          outcome = "exhausted";
          return;
        }
        await this.usage.insertOne({
          _id: input.fragmentId,
          kind: "reservation",
          month,
          seconds: input.seconds,
          reservedAt: now,
        }, { session });
        outcome = "reserved";
      });
      return outcome;
    } catch (error) {
      if (errorCode(error) === 11000) {
        const existing = await this.usage.findOne({
          _id: input.fragmentId,
          kind: "reservation",
        });
        if (existing) return "already_reserved";
        return "exhausted";
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async releaseMonthlyUsage(fragmentId: string): Promise<void> {
    const session = this.database.client.startSession();
    try {
      await session.withTransaction(async () => {
        const reservation = await this.usage.findOne(
          { _id: fragmentId, kind: "reservation" },
          { session },
        );
        if (!reservation) return;
        const deleted = await this.usage.deleteOne(
          { _id: fragmentId, kind: "reservation" },
          { session },
        );
        if (deleted.deletedCount !== 1) return;
        await this.usage.updateOne(
          { _id: `month:${String(reservation.month)}` },
          {
            $inc: {
              reservedSeconds: -Number(reservation.seconds),
              reservedRequests: -1,
            },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }
}
