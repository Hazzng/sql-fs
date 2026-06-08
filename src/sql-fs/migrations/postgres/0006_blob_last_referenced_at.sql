-- Migration 0006: blob last_referenced_at — supports grace-period orphan GC.
--
-- Existing rows are left NULL (ADD COLUMN with no default is an instant catalog-only
-- change — no table rewrite). GC treats NULL as "ancient" so the pre-existing orphan
-- backlog is collectible on the first run. New inserts default to now(); every
-- reference (including dedup re-adoption) bumps it via ON CONFLICT DO UPDATE, which
-- also takes the row lock that serializes a re-adopting writer against GC's DELETE.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / ALTER ... SET DEFAULT / CREATE INDEX IF NOT EXISTS.
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ;
ALTER TABLE blobs ALTER COLUMN last_referenced_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_blobs_last_referenced_at ON blobs(last_referenced_at);
