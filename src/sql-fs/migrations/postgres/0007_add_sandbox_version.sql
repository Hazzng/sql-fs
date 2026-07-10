-- Migration 0007: Add sandbox version epoch used to pin script-open state.
-- Existing sandboxes start at epoch 0; writers bump this when new durable state
-- is published.
ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
