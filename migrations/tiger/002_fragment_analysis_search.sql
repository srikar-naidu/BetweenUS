ALTER TABLE fragment_search
  ADD COLUMN IF NOT EXISTS moment_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS analysis_version text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS fragment_search_entities_idx
  ON fragment_search USING gin (entity_keys);
