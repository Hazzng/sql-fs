-- Migration 0002: Add runtime-option columns to sandboxes for rehydration.
-- The `owner` column already exists from 0000; these two columns let
-- cold-starting replicas reconstruct Bash with the correct runtimes.

ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS python     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS javascript BOOLEAN NOT NULL DEFAULT false;
