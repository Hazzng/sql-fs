-- Migration 0005: Row-Level Security — defense-in-depth sandbox isolation.
--
-- Audit H1: RLS was never enabled. Isolation relied solely on the
-- application-level `WHERE sandbox_id = …` filters and `SET LOCAL app.sandbox_id`
-- was effectively dead code. This migration adds the missing DB-level backstop
-- on the per-sandbox data tables (inodes, dirents) and on the sandbox metadata
-- table (sandboxes).
--
-- Policy semantics (intentional, fail-safe for trusted global ops):
--   * When a sandbox context is active — i.e. the transaction has run
--     `set_config('app.sandbox_id', <id>, true)` — every row read or written
--     through that connection is constrained to that sandbox. This is the
--     isolation backstop: a data-plane query can no longer reach another
--     sandbox's rows even if an app-level WHERE filter is missing or bypassed.
--   * When NO sandbox context is set the policy permits all rows. This branch is
--     used ONLY by trusted, server-side operations that legitimately span
--     sandboxes and never run with an attacker-chosen context:
--       - blob GC (`gcOrphanBlobs` scans every inode; a strict policy here would
--         see zero inodes and delete the entire blob store),
--       - blob-cache warming (`getBlobsForSandbox`),
--       - sandbox metadata create / read / list on the `sandboxes` table.
--     Because user-facing data-plane reads always set the context first, the
--     escape does not weaken isolation for any client-reachable path.
--
-- "No context" must match BOTH states `current_setting('app.sandbox_id', true)`
-- can take: NULL on a brand-new connection, and '' (empty string) on a pooled
-- connection that set the GUC via SET LOCAL in an earlier, now-committed
-- transaction (the placeholder reverts to '' rather than NULL). `NULLIF(…, '')`
-- collapses both to NULL so the escape covers both. (See the
-- "transaction-local" assertion in postgres.test.ts.)
--
-- The OR-escape form is also robust to the composite write statements, which set
-- `app.sandbox_id` inline in a CTE: regardless of intra-statement evaluation
-- order, the WITH CHECK passes (matching id, or empty context → allow), and
-- those writes already pin `sandbox_id` to the correct value explicitly.
--
-- FORCE is required so the policy also applies to the table owner — the role the
-- app and the migration runner connect as in single-role deployments (e.g. Neon).
--
-- `blobs` is deliberately excluded: it is a global content-addressable store
-- (cross-sandbox dedup keyed by sha256) and has no sandbox_id column.
--
-- Idempotent: the startup runner re-applies every migration on each boot, so
-- ENABLE/FORCE are no-ops when already set and each policy is dropped first.

-- ── inodes ────────────────────────────────────────────────────────────────────
ALTER TABLE inodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inodes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sandbox_isolation ON inodes;
CREATE POLICY sandbox_isolation ON inodes
    USING (
        sandbox_id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    )
    WITH CHECK (
        sandbox_id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    );

-- ── dirents ───────────────────────────────────────────────────────────────────
ALTER TABLE dirents ENABLE ROW LEVEL SECURITY;
ALTER TABLE dirents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sandbox_isolation ON dirents;
CREATE POLICY sandbox_isolation ON dirents
    USING (
        sandbox_id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    )
    WITH CHECK (
        sandbox_id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    );

-- ── sandboxes ───────────────────────────────────────────────────────────────────
ALTER TABLE sandboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandboxes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sandbox_isolation ON sandboxes;
CREATE POLICY sandbox_isolation ON sandboxes
    USING (
        id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    )
    WITH CHECK (
        id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    );
