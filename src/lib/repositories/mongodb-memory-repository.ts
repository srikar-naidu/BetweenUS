import { randomUUID } from "node:crypto";
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
  private readonly fragments: Collection<FragmentDocument>;
  private readonly moments: Collection<MomentDocument>;

  constructor(database: Db) {
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
    const fragment: FragmentDocument = {
      _id: randomUUID(),
      ...input,
      caption: input.caption ?? null,
      metadata: input.metadata ?? {},
      visibility: input.visibility ?? "private",
      status: "uploaded",
      createdAt: new Date(),
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
      capturedAt: { $gte: startAt, $lte: endAt },
    };
    const documents = await this.fragments
      .find(query)
      .sort({ capturedAt: 1 })
      .limit(limit)
      .toArray();
    return documents.map(asFragment);
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