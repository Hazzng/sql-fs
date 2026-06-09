-- Migration 0006: replace boolean `python` with nullable `python_runtime` enum.
-- Expand/contract step N (this release). Rolling-deploy-safe: reads COALESCE the
-- legacy column, writes dual-write it (see postgres.ts). Step N+1 (later release)
-- drops `python` and removes the COALESCE/dual-write.

ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS python_runtime TEXT;

-- CHECK constraint (idempotent: add only if absent).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sandboxes_python_runtime_check'
    ) THEN
        ALTER TABLE sandboxes
            ADD CONSTRAINT sandboxes_python_runtime_check
            CHECK (python_runtime IN ('stdlib','pyodide'));
    END IF;
END $$;

-- Backfill ONLY rows not yet migrated, and ONLY while the legacy `python` column
-- still exists (so this is a no-op after the N+1 drop release — never errors).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'sandboxes'::regclass
          AND attname = 'python' AND NOT attisdropped
    ) THEN
        UPDATE sandboxes
        SET python_runtime = CASE WHEN python THEN 'stdlib' END
        WHERE python_runtime IS NULL;
    END IF;
END $$;
