-- Migration 0007: durable per-sandbox version epoch.
--
-- Add the epoch as BIGINT so it remains safe for monotonically increasing
-- version counters. The explicit backfill also repairs a pre-existing nullable
-- column if this migration is re-run against a partially migrated database.
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS version BIGINT;
UPDATE sandboxes SET version = 0 WHERE version IS NULL;
ALTER TABLE sandboxes ALTER COLUMN version SET DEFAULT 0;
ALTER TABLE sandboxes ALTER COLUMN version SET NOT NULL;
