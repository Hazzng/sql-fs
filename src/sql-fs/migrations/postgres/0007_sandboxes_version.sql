-- Migration 0007: durable sandbox version epoch.
-- Existing sandboxes are backfilled to zero by the non-null default; new rows
-- inherit the same baseline until their epoch is advanced by the application.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS safely supports repeat application.
ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
