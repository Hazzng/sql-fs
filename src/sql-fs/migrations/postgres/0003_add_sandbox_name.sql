-- 0003: Add optional human-readable name to sandboxes
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS name TEXT;
