-- Migration 0000: Initial schema for sql-fs-api (Postgres/Neon)
-- Tables: sandboxes, inodes, dirents, blobs

-- Sandboxes: one row per isolated filesystem environment.
-- root_inode is set immediately after the root inode is created, so it is
-- nullable here to break the circular FK dependency with inodes.
CREATE TABLE IF NOT EXISTS sandboxes (
    id          TEXT        PRIMARY KEY,
    root_inode  BIGINT,                                  -- set after root inode insert
    owner       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Inodes: one row per filesystem node (file, directory, or symlink).
-- Deleting a sandbox cascades to all its inodes.
CREATE TABLE IF NOT EXISTS inodes (
    id              BIGSERIAL   PRIMARY KEY,
    sandbox_id      TEXT        NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    kind            SMALLINT    NOT NULL CHECK (kind IN (1, 2, 3)),  -- 1=file 2=dir 3=symlink
    mode            INTEGER     NOT NULL DEFAULT 0,
    size            BIGINT      NOT NULL DEFAULT 0,
    mtime           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nlink           INTEGER     NOT NULL DEFAULT 1,
    content_sha256  BYTEA,
    symlink_target  TEXT
);

-- Dirents: adjacency-list directory entries, PK is (parent_inode_id, name).
-- Cascades on both the parent inode and the sandbox.
CREATE TABLE IF NOT EXISTS dirents (
    parent_inode_id BIGINT  NOT NULL REFERENCES inodes(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    inode_id        BIGINT  NOT NULL REFERENCES inodes(id) ON DELETE CASCADE,
    sandbox_id      TEXT    NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_inode_id, name)
);

-- Blobs: content-addressable store, global across all sandboxes.
-- sha256 is stored as raw BYTEA (32 bytes).
CREATE TABLE IF NOT EXISTS blobs (
    sha256  BYTEA   PRIMARY KEY,
    data    BYTEA   NOT NULL,
    size    BIGINT  NOT NULL DEFAULT 0
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_inodes_sandbox_id        ON inodes(sandbox_id);
CREATE INDEX IF NOT EXISTS idx_dirents_inode_id         ON dirents(inode_id);
CREATE INDEX IF NOT EXISTS idx_inodes_content_sha256    ON inodes(content_sha256) WHERE content_sha256 IS NOT NULL;
