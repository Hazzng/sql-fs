-- Migration 0007: durable sandbox epoch.
--
-- Every sandbox starts at epoch zero; writers can advance this value to detect
-- stale state without relying on process-local metadata. Existing rows receive
-- the same initial epoch when the column is added.
--
-- Idempotent: startup reapplies every migration on each boot.
ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
