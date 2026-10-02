import { Pool } from "pg";
import type {
  TemporalFragmentCandidate,
  TemporalFragmentQuery,
} from "@/lib/domain/memory";

interface SearchIndexRow {
  fragment_id: string;
  captured_at: Date;
  semantic_summary: string;
  entity_keys: string[];
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
  }): Promise<void> {
    await this.sql.query(
      `INSERT INTO fragment_search
        (group_id, fragment_id, captured_at, semantic_summary, entity_keys)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id, fragment_id, captured_at)
       DO UPDATE SET semantic_summary = EXCLUDED.semantic_summary,
                     entity_keys = EXCLUDED.entity_keys`,
      [
        input.groupId,
        input.fragmentId,
        input.capturedAt,
        input.semanticSummary,
        input.entityKeys ?? [],
      ],
    );
  }

  async findCandidates(
    query: TemporalFragmentQuery,
  ): Promise<TemporalFragmentCandidate[]> {
    const result = await this.sql.query(
      `SELECT fragment_id, captured_at, semantic_summary, entity_keys
       FROM fragment_search
       WHERE group_id = $1
         AND captured_at >= $2
         AND captured_at <= $3
         AND ($4::text IS NULL OR fragment_id <> $4)
         AND ($5::text IS NULL OR to_tsvector('simple', semantic_summary)
              @@ plainto_tsquery('simple', $5))
       ORDER BY abs(extract(epoch FROM (captured_at - $6::timestamptz))) ASC
       LIMIT $7`,
      [
        query.groupId,
        query.startAt,
        query.endAt,
        query.excludeFragmentId ?? null,
        query.searchText?.trim() || null,
        new Date((query.startAt.getTime() + query.endAt.getTime()) / 2),
        Math.max(1, Math.min(query.limit ?? 20, 100)),
      ],
    );

    return result.rows.map((row) => ({
      fragmentId: row.fragment_id,
      capturedAt: row.captured_at,
      semanticSummary: row.semantic_summary,
      entityKeys: row.entity_keys,
    }));
  }
}