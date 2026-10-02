CREATE TABLE IF NOT EXISTS fragment_search (
  group_id text NOT NULL,
  fragment_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  semantic_summary text NOT NULL DEFAULT '',
  entity_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  PRIMARY KEY (group_id, fragment_id, captured_at)
);

CREATE INDEX IF NOT EXISTS fragment_search_group_time_idx
  ON fragment_search (group_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS fragment_search_summary_fts_idx
  ON fragment_search USING gin (to_tsvector('simple', semantic_summary));