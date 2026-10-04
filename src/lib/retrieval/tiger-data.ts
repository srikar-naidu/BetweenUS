import { Pool } from "pg";
import type {
  TemporalFragmentCandidate,
  TemporalFragmentQuery,
} from "@/lib/domain/memory";
import { rankFragmentCandidates } from "@/lib/retrieval/ranking";

interface SearchIndexRow {
  fragment_id: string;
  captured_at: Date;
  semantic_summary: string;
  entity_keys: string[];
  moment_ids?: string[];
}

interface SqlExecutor {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: SearchIndexRow[] }>;
}

interface TigerCache {
  pool?: Pool;
}

const globalForTiger = globalThis as typeof globalThis & {
  betweenUsTiger?: TigerCache;
};

const cache = (globalForTiger.betweenUsTiger ??= {});

function getTigerPool(): Pool {
  const connectionString = process.env.TIGER_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TIGER_DATABASE_URL is required for fragment retrieval");
  }
  cache.pool ??= new Pool({ connectionString });
  return cache.pool;
}

function getTigerExecutor(): SqlExecutor {
  const pool = getTigerPool();
  return {
    query: (text, values) => pool.query<SearchIndexRow>(text, values),
  };
}

export class TigerDataFragmentSearch {
  constructor(private readonly sql: SqlExecutor = getTigerExecutor()) {}

  async indexGroupVisibleFragment(input: {
    groupId: string;
    fragmentId: string;
    capturedAt: Date;
    semanticSummary: string;
    entityKeys?: string[];
    momentIds?: string[];
    analysisVersion?: string;
    modelVersion?: string;
  }): Promise<void> {
    await this.sql.query(
      `INSERT INTO fragment_search
        (group_id, fragment_id, captured_at, semantic_summary, entity_keys, moment_ids, analysis_version, model_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (group_id, fragment_id, captured_at)
       DO UPDATE SET semantic_summary = EXCLUDED.semantic_summary,
                     entity_keys = EXCLUDED.entity_keys,
                     moment_ids = EXCLUDED.moment_ids,
                     analysis_version = EXCLUDED.analysis_version,
                     model_version = EXCLUDED.model_version`,
      [
        input.groupId,
        input.fragmentId,
        input.capturedAt,
        input.semanticSummary,
        input.entityKeys ?? [],
        input.momentIds ?? [],
        input.analysisVersion ?? "demo-v1",
        input.modelVersion ?? "demo",
      ],
    );
  }

  async removeGroupVisibleFragment(groupId: string, fragmentId: string): Promise<void> {
    await this.sql.query(
      `DELETE FROM fragment_search
       WHERE group_id = $1 AND fragment_id = $2`,
      [groupId, fragmentId],
    );
  }

  async removeGroupFragments(groupId: string): Promise<void> {
    await this.sql.query(
      `DELETE FROM fragment_search WHERE group_id = $1`,
      [groupId],
    );
  }

  async findCandidates(
    query: TemporalFragmentQuery,
  ): Promise<TemporalFragmentCandidate[]> {
    const result = await this.sql.query(
      `SELECT fragment_id, captured_at, semantic_summary, entity_keys, moment_ids
       FROM fragment_search
       WHERE group_id = $1
         AND captured_at >= $2
         AND captured_at <= $3
         AND ($4::text IS NULL OR fragment_id <> $4)
       ORDER BY abs(extract(epoch FROM (captured_at - $5::timestamptz))) ASC
       LIMIT $6`,
      [
        query.groupId,
        query.startAt,
        query.endAt,
        query.excludeFragmentId ?? null,
        new Date((query.startAt.getTime() + query.endAt.getTime()) / 2),
        100,
      ],
    );

    const candidates: TemporalFragmentCandidate[] = result.rows.map((row) => ({
      fragmentId: row.fragment_id,
      capturedAt: row.captured_at,
      semanticSummary: row.semantic_summary,
      entityKeys: row.entity_keys,
      momentIds: row.moment_ids ?? [],
      retrievalScore: 0,
      matchedSignals: [],
    }));
    return rankFragmentCandidates(query, candidates);
  }
}