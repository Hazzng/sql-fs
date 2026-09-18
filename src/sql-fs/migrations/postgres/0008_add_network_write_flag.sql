-- Migration 0008: Add the network_write capability flag to sandboxes.
-- Existing rows default to false: a sandbox may reach the network (0004's
-- `network` flag) but its `requests` compatibility shim refuses POST / PUT /
-- PATCH / DELETE unless the caller opted in at create time.
ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS network_write BOOLEAN NOT NULL DEFAULT false;
