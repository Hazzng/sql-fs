-- Migration 0007: durable sandbox fencing version.
--
-- ADD COLUMN with a constant default backfills existing rows with zero and
-- applies the same default to future sandbox rows. IF NOT EXISTS keeps startup
-- migration replay safe.
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
