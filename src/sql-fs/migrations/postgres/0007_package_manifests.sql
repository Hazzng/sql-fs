-- Migration 0007: package manifests — tenant-global wheel extraction records
-- plus the per-sandbox installed-package ledger.
--
-- `package_manifests` / `package_manifest_files` describe what one wheel
-- (identified by the sha256 of the downloaded .whl) extracts to: a list of
-- (path, blob_sha256, mode, size) rows. They carry NO sandbox_id and NO RLS
-- for the same reason `blobs` does not (0000, 0005): the extraction of a given
-- wheel is identical for every sandbox in the tenant, so the rows are a
-- content-addressed, tenant-global cache keyed by the wheel hash. Nothing in
-- them is sandbox-specific, and the sandbox-visible consequence of a manifest
-- is only ever created through `bulkGraft`, which runs under the sandbox
-- context and re-validates every path. The sandbox-scoped table in this
-- migration — `sandbox_packages` — is the one that carries RLS.
--
-- `manifest_format` starts at 1 and is bumped whenever extraction rules, path
-- spreading, mode normalisation or the compat overlay change. Lookups match on
-- (wheel_sha256, manifest_format); an old-format row is a miss and is replaced.
--
-- The FK `package_manifest_files.blob_sha256 -> blobs(sha256) ON DELETE
-- RESTRICT` is the GC safety net: if a manifest row commits first, GC's DELETE
-- of that blob fails and the transaction retries with the manifest visible; if
-- GC's DELETE commits first, the manifest INSERT fails and the wheel is
-- re-ingested. The touch-then-insert protocol in `ingestBlobs` makes both
-- orderings rare; the FK makes them harmless.
--
-- `sandbox_packages.wheel_sha256 -> package_manifests(wheel_sha256) ON DELETE
-- RESTRICT` is why the manifest TTL sweep must carry a `NOT EXISTS` guard: a
-- manifest an installed sandbox still points at is never collectible.
--
-- Idempotent: the startup runner re-applies every migration on each boot, so
-- every statement is IF NOT EXISTS, and the policy is dropped before creation.

-- ── package_manifests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS package_manifests (
    wheel_sha256    BYTEA       PRIMARY KEY,
    manifest_format INTEGER     NOT NULL,
    name            TEXT        NOT NULL,
    version         TEXT        NOT NULL,
    file_count      INTEGER     NOT NULL,
    total_bytes     BIGINT      NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE package_manifests IS
    'Tenant-global wheel extraction records keyed by the wheel sha256. No sandbox_id and no RLS: like blobs, the rows are identical for every sandbox and are only made visible to one through bulkGraft under the sandbox context.';

CREATE INDEX IF NOT EXISTS idx_package_manifests_name_version ON package_manifests(name, version);
CREATE INDEX IF NOT EXISTS idx_package_manifests_last_used_at ON package_manifests(last_used_at);

-- ── package_manifest_files ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS package_manifest_files (
    wheel_sha256 BYTEA   NOT NULL REFERENCES package_manifests(wheel_sha256) ON DELETE CASCADE,
    path         TEXT    NOT NULL,
    blob_sha256  BYTEA   NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
    mode         INTEGER NOT NULL,
    size         BIGINT  NOT NULL,
    PRIMARY KEY (wheel_sha256, path)
);

COMMENT ON TABLE package_manifest_files IS
    'File rows of a wheel manifest: path -> blob. No sandbox_id and no RLS (tenant-global CAS, like blobs). The blob FK is ON DELETE RESTRICT so orphan-blob GC can never collect a blob a manifest still roots.';

CREATE INDEX IF NOT EXISTS idx_package_manifest_files_blob ON package_manifest_files(blob_sha256);

-- ── sandbox_packages ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sandbox_packages (
    sandbox_id   TEXT        NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    version      TEXT        NOT NULL,
    wheel_sha256 BYTEA       NOT NULL REFERENCES package_manifests(wheel_sha256) ON DELETE RESTRICT,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sandbox_id, name)
);

COMMENT ON TABLE sandbox_packages IS
    'Per-sandbox installed-package ledger (ownership, version, quota input). Sandbox-scoped, so it carries the same RLS policy shape as inodes/dirents (0005).';

CREATE INDEX IF NOT EXISTS idx_sandbox_packages_wheel ON sandbox_packages(wheel_sha256);

-- RLS: identical semantics to `inodes` in 0005 — a set sandbox context pins
-- every row to that sandbox; no context (NULL or '') permits all rows, which is
-- the branch the trusted, context-less GC connection uses.
ALTER TABLE sandbox_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_packages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sandbox_isolation ON sandbox_packages;
CREATE POLICY sandbox_isolation ON sandbox_packages
    USING (
        sandbox_id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    )
    WITH CHECK (
        sandbox_id = current_setting('app.sandbox_id', true)
        OR NULLIF(current_setting('app.sandbox_id', true), '') IS NULL
    );
