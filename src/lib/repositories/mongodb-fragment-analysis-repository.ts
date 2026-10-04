import type { Collection, Db, Document } from "mongodb";
import type { FragmentAnalysis } from "@/lib/ai/fragment-analysis";

type StoredAnalysis = Omit<FragmentAnalysis, "id"> & { _id: string } & Document;

const globalForAnalysisIndexes = globalThis as typeof globalThis & {
  betweenUsFragmentAnalysisIndexes?: WeakMap<Db, Promise<void>>;
};
const analysisIndexes = (globalForAnalysisIndexes.betweenUsFragmentAnalysisIndexes ??= new WeakMap());

function asAnalysis(record: StoredAnalysis): FragmentAnalysis {
  const { _id, ...analysis } = record;
  return { ...analysis, id: _id };
}

export class MongoFragmentAnalysisRepository {
  private readonly analyses: Collection<StoredAnalysis>;

  constructor(private readonly database: Db) {
    this.analyses = database.collection<StoredAnalysis>("fragment_analyses");
  }

  async ensureIndexes(): Promise<void> {
    let pending = analysisIndexes.get(this.database);
    if (!pending) {
      pending = Promise.all([
        this.analyses.createIndex(
          { groupId: 1, fragmentId: 1, analysisVersion: 1 },
          { unique: true },
        ),
        this.analyses.createIndex({ groupId: 1, analyzedAt: -1 }),
      ]).then(() => undefined);
      analysisIndexes.set(this.database, pending);
    }
    try {
      await pending;
    } catch (error) {
      analysisIndexes.delete(this.database);
      throw error;
    }
  }

  async save(analysis: FragmentAnalysis): Promise<FragmentAnalysis> {
    await this.ensureIndexes();
    const { id, ...document } = analysis;
    await this.analyses.updateOne(
      {
        _id: id,
        groupId: analysis.groupId,
        fragmentId: analysis.fragmentId,
        analysisVersion: analysis.analysisVersion,
      },
      {
        $set: document,
        $setOnInsert: { _id: id },
      },
      { upsert: true },
    );
    const saved = await this.analyses.findOne({
      _id: id,
      groupId: analysis.groupId,
      fragmentId: analysis.fragmentId,
    });
    if (!saved) throw new Error("Fragment analysis could not be read after upsert");
    return asAnalysis(saved);
  }

  async find(
    groupId: string,
    fragmentId: string,
    analysisVersion: string,
  ): Promise<FragmentAnalysis | null> {
    await this.ensureIndexes();
    const record = await this.analyses.findOne({ groupId, fragmentId, analysisVersion });
    return record ? asAnalysis(record) : null;
  }

  async findMany(
    groupId: string,
    fragmentIds: readonly string[],
    analysisVersion: string,
  ): Promise<FragmentAnalysis[]> {
    await this.ensureIndexes();
    if (!fragmentIds.length) return [];
    const records = await this.analyses.find({
      groupId,
      fragmentId: { $in: [...fragmentIds] },
      analysisVersion,
    }).toArray();
    return records.map(asAnalysis);
  }

  async delete(groupId: string, fragmentId: string): Promise<void> {
    await this.ensureIndexes();
    await this.analyses.deleteMany({ groupId, fragmentId });
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.ensureIndexes();
    await this.analyses.deleteMany({ groupId });
  }
}
