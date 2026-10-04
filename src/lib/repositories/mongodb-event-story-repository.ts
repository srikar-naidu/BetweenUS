import type { Collection, Db, Document } from "mongodb";
import type { EventStoryDocument } from "@/lib/domain/memory";

type StoredEventStory = Omit<EventStoryDocument, "id"> & { _id: string } & Document;

const globalForEventStories = globalThis as typeof globalThis & {
  betweenUsEventStoryIndexes?: WeakMap<Db, Promise<void>>;
};
const eventStoryIndexes = (globalForEventStories.betweenUsEventStoryIndexes ??= new WeakMap());

function asEventStory(record: StoredEventStory): EventStoryDocument {
  const { _id, ...story } = record;
  return { ...story, id: _id };
}

export class MongoEventStoryRepository {
  private readonly stories: Collection<StoredEventStory>;

  constructor(private readonly database: Db) {
    this.stories = database.collection<StoredEventStory>("event_story_documents");
  }

  async ensureIndexes(): Promise<void> {
    let pending = eventStoryIndexes.get(this.database);
    if (!pending) {
      pending = this.stories.createIndex({ groupId: 1 }, { unique: true }).then(() => undefined);
      eventStoryIndexes.set(this.database, pending);
    }
    try {
      await pending;
    } catch (error) {
      eventStoryIndexes.delete(this.database);
      throw error;
    }
  }

  async find(groupId: string): Promise<EventStoryDocument | null> {
    await this.ensureIndexes();
    const record = await this.stories.findOne({ groupId });
    return record ? asEventStory(record) : null;
  }

  async save(input: {
    groupId: string;
    title: string;
    narrative: string;
    momentIds: string[];
    updatedBy: string;
    expectedRevision: number;
  }): Promise<EventStoryDocument | null> {
    await this.ensureIndexes();
    const now = new Date();
    const existing = await this.stories.findOne({ groupId: input.groupId });
    if (existing) {
      if ((existing.revision ?? 0) !== input.expectedRevision) return null;
      const result = await this.stories.updateOne(
        { _id: existing._id, groupId: input.groupId, revision: input.expectedRevision },
        {
          $set: {
            title: input.title,
            narrative: input.narrative,
            momentIds: input.momentIds,
            updatedBy: input.updatedBy,
            updatedAt: now,
          },
          $inc: { revision: 1 },
        },
      );
      if (result.modifiedCount !== 1) return null;
    } else {
      if (input.expectedRevision !== 0) return null;
      const document: StoredEventStory = {
        _id: input.groupId,
        groupId: input.groupId,
        title: input.title,
        narrative: input.narrative,
        momentIds: input.momentIds,
        updatedBy: input.updatedBy,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.stories.insertOne(document);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== 11000
        ) {
          throw error;
        }
        return null;
      }
    }
    return this.find(input.groupId);
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.ensureIndexes();
    await this.stories.deleteOne({ groupId });
  }
}
