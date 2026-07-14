-- Migration 0007: durable fencing epochs for sandbox lifecycle operations.
--
-- `sandboxes.version` is the live row's fencing token.  A deleted sandbox row
-- cannot carry that token, so sandbox_epochs keeps the last epoch and a
-- tombstone for the ID.  The table intentionally has no FK to sandboxes: its
-- rows must survive deletion of the live sandbox row and prevent ID reuse from
-- resetting an old writer's epoch.
--
-- Idempotent: startup applies every migration on every boot.

ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sandbox_epochs (
    sandbox_id  TEXT        PRIMARY KEY,
    epoch       BIGINT      NOT NULL DEFAULT 0,
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
