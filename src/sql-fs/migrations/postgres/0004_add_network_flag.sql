-- Migration 0004: Add network flag to sandboxes for outbound-fetch control.
-- Existing rows default to false (air-gapped), matching the secure-by-default
-- behaviour enforced at session creation time.
ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS network BOOLEAN NOT NULL DEFAULT false;
