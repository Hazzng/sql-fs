# PRD: SQL-FS — Persistent Filesystem Backends + HTTP/MCP API for just-bash

## Introduction

just-bash is a TypeScript virtual bash interpreter with an in-memory filesystem. Today, all file state lives in a JavaScript `Map` and is lost when the process dies. This feature adds **persistent filesystem backends** (SQL databases and Azure FileShare) behind a factory pattern, plus an **HTTP + MCP API layer** so AI agents and developers can create sandboxed bash environments remotely over the network.

The core idea: replace `InMemoryFs` with `SqlFs` (backed by Postgres, MySQL, or Azure SQL) or `AzureFileShareFs` (backed by a mounted Azure FileShare), deploy in a container, and expose sandbox lifecycle + file operations + bash execution via REST and MCP endpoints.

## Goals

- Implement `SqlFs` as a new `IFileSystem` backend that stores files/directories/symlinks in SQL tables, with a `SqlDialect` abstraction supporting Postgres, MySQL, and Azure SQL
- Implement `AzureFileShareFs` integration using the existing `ReadWriteFs` pointed at a mounted FileShare volume
- Create a factory function (`createSandboxFs`) that selects the backend from configuration
- Build an HTTP API (Hono) exposing sandbox CRUD, file operations, bash execution, and ingest/export
- Build an MCP server exposing the same capabilities as compact tools (minimal context window bloat)
- Deploy as a container on Azure Container Apps (or any container platform)
- Isolate sandboxes via Row-Level Security (Postgres/Azure SQL) or app-level WHERE clauses (MySQL)
- Use in-memory caching (path cache + content LRU) to minimize SQL round-trips

## User Stories

---

### Epic 1: SqlDialect Interface & Shared Types

#### US-001: SqlDialect interface definition
**Description:** As a developer, I want the `SqlDialect` interface defined so that dialect implementations have a clear contract to fulfill.

**Acceptance Criteria:**
- [ ] `SqlDialect` interface in `src/fs/sql-fs/types.ts`
- [ ] Methods grouped: connection (`connect`, `disconnect`), transactions (`transaction`), context (`setSandboxContext`)
- [ ] Each method has JSDoc describing behavior, params, return type, and error semantics
- [ ] Typecheck passes

#### US-002: Shared types for inode, dirent, cache entry
**Description:** As a developer, I want shared type definitions for database rows and cache entries so that SqlFs and all dialects use consistent shapes.

**Acceptance Criteria:**
- [ ] `InodeRow` type: `{ id: bigint, sandboxId: string, kind: 1|2|3, mode: number, size: number, mtime: Date, nlink: number, contentSha256: Uint8Array|null, symlinkTarget: string|null }`
- [ ] `DirentRow` type: `{ parentInodeId: bigint, name: string, inodeId: bigint }`
- [ ] `PathCacheEntry` type: `{ inodeId: bigint, kind: 1|2|3, mode: number, size: number, mtime: Date, contentSha256: Uint8Array|null, symlinkTarget: string|null }`
- [ ] `Transaction` generic type that each dialect can specialize
- [ ] `StorageBackend` union type for factory config
- [ ] All types in `src/fs/sql-fs/types.ts`
- [ ] Typecheck passes

#### US-003: FS error constructors and translation
**Description:** As a developer, I want helper functions that create standard FS errors (ENOENT, EEXIST, etc.) and translate SQL-specific errors into them.

**Acceptance Criteria:**
- [ ] `src/fs/sql-fs/errors.ts` with constructors: `createEnoent(path)`, `createEexist(path)`, `createEisdir(path)`, `createEnotdir(path)`, `createEnotempty(path)`, `createEloop(path)`, `createEperm(path, op)`
- [ ] Each sets `code` property (e.g., `'ENOENT'`) matching just-bash convention
- [ ] `translateSqlError(err, path)` function that maps: Postgres SQLSTATE codes, MySQL error numbers, T-SQL error numbers to the appropriate FS error
- [ ] All errors passed through `sanitizeFsError` from `src/fs/sanitize-error.ts`
- [ ] Unit tests: each constructor produces correct code + message; translateSqlError maps known codes
- [ ] Typecheck passes

---

### Epic 2: SqlDialect — Sandbox & Inode Operations

#### US-004: Postgres dialect — connection and sandbox context
**Description:** As a developer, I want the Postgres dialect to connect via `postgres` driver and set sandbox context per transaction.

**Acceptance Criteria:**
- [ ] `PostgresDialect` class in `src/fs/sql-fs/dialects/postgres.ts`
- [ ] Constructor accepts connection string
- [ ] `connect()` establishes pool with `prepare: false` (transaction-pooler compatible)
- [ ] `disconnect()` closes pool
- [ ] `transaction(fn)` wraps callback in `BEGIN`/`COMMIT` with `ROLLBACK` on error
- [ ] `setSandboxContext(tx, sandboxId)` executes `SET LOCAL app.sandbox_id = $1`
- [ ] Unit test: connect, set context, verify `current_setting('app.sandbox_id')` returns correct value
- [ ] Typecheck passes

#### US-005: Postgres dialect — createSandbox and deleteSandbox
**Description:** As a developer, I want to create and delete sandbox root structures in Postgres.

**Acceptance Criteria:**
- [ ] `createSandbox(tx, sandboxId)` inserts root inode (kind=2, mode=0o755), inserts row in `sandboxes` table, creates default directories (`/home`, `/home/user`, `/tmp`, `/bin`), returns `{ rootInodeId }`
- [ ] `deleteSandbox(tx, sandboxId)` deletes from `sandboxes`, cascade deletes all inodes and dirents for that sandbox_id
- [ ] Unit test: create sandbox, verify root inode exists, verify default dirs exist via `listDirents`
- [ ] Unit test: create then delete sandbox, verify no inodes/dirents remain
- [ ] Typecheck passes

#### US-006: Postgres dialect — createInode, getInode, updateInode, deleteInode
**Description:** As a developer, I want CRUD operations on inodes in Postgres.

**Acceptance Criteria:**
- [ ] `createInode(tx, opts)` inserts into `inodes` table, returns new id
- [ ] `getInode(tx, inodeId)` returns `InodeRow` or null
- [ ] `updateInode(tx, inodeId, updates)` updates specified fields (mode, size, mtime, contentSha256)
- [ ] `deleteInode(tx, inodeId)` deletes inode row
- [ ] Unit test: create file inode with content_sha256, get it back, verify all fields match
- [ ] Unit test: create dir inode (kind=2, no content_sha256), verify kind=2
- [ ] Unit test: update mtime and mode, verify changes persisted
- [ ] Unit test: delete inode, verify getInode returns null
- [ ] Typecheck passes

#### US-007: Postgres dialect — incrementNlink, decrementNlink
**Description:** As a developer, I want to atomically increment/decrement hardlink counts on inodes.

**Acceptance Criteria:**
- [ ] `incrementNlink(tx, inodeId)` executes `UPDATE inodes SET nlink = nlink + 1 WHERE id = $1`
- [ ] `decrementNlink(tx, inodeId)` executes `UPDATE ... SET nlink = nlink - 1 ... RETURNING nlink`, returns new nlink value
- [ ] Unit test: create inode (nlink=1), increment, verify nlink=2
- [ ] Unit test: decrement from 2 to 1, verify return value is 1
- [ ] Unit test: decrement from 1 to 0, verify return value is 0
- [ ] Typecheck passes

---

### Epic 3: SqlDialect — Dirent Operations

#### US-008: Postgres dialect — insertDirent
**Description:** As a developer, I want to insert a directory entry linking a name to an inode.

**Acceptance Criteria:**
- [ ] `insertDirent(tx, parentId, name, inodeId)` inserts into `dirents` table
- [ ] Throws EEXIST-translatable error if `(parentId, name)` already exists (PK violation)
- [ ] Unit test: insert dirent, verify it appears in `listDirents`
- [ ] Unit test: insert duplicate name under same parent, verify error thrown
- [ ] Typecheck passes

#### US-009: Postgres dialect — upsertDirent
**Description:** As a developer, I want to insert-or-replace a directory entry so that `writeFile` can overwrite existing files atomically.

**Acceptance Criteria:**
- [ ] `upsertDirent(tx, parentId, name, inodeId)` uses `INSERT ... ON CONFLICT (parent_inode_id, name) DO UPDATE SET inode_id = EXCLUDED.inode_id`
- [ ] Returns the previously-referenced inodeId if a replacement happened, null if new insert
- [ ] Unit test: upsert new entry, returns null
- [ ] Unit test: upsert over existing entry, returns old inodeId
- [ ] Typecheck passes

#### US-010: Postgres dialect — deleteDirent
**Description:** As a developer, I want to remove a directory entry by parent and name.

**Acceptance Criteria:**
- [ ] `deleteDirent(tx, parentId, name)` deletes from `dirents`, returns the removed inodeId
- [ ] Throws ENOENT-translatable error if entry doesn't exist
- [ ] Unit test: insert then delete dirent, verify removed
- [ ] Unit test: delete non-existent dirent, verify error
- [ ] Typecheck passes

#### US-011: Postgres dialect — listDirents
**Description:** As a developer, I want to list all directory entries under a parent inode.

**Acceptance Criteria:**
- [ ] `listDirents(tx, parentId)` returns `DirentRow[]` joined with inode metadata (kind, mode, size, mtime)
- [ ] Results ordered by name
- [ ] Unit test: create parent dir with 3 children (file, dir, symlink), verify all returned with correct kinds
- [ ] Unit test: empty directory returns empty array
- [ ] Typecheck passes

#### US-012: Postgres dialect — moveDirent
**Description:** As a developer, I want to move/rename a directory entry in a single UPDATE.

**Acceptance Criteria:**
- [ ] `moveDirent(tx, oldParent, oldName, newParent, newName)` executes single `UPDATE dirents SET parent_inode_id = $3, name = $4 WHERE parent_inode_id = $1 AND name = $2`
- [ ] Throws ENOENT-translatable error if source doesn't exist
- [ ] If destination already exists, deletes existing dirent first (in same transaction)
- [ ] Unit test: rename file within same directory
- [ ] Unit test: move file to different directory
- [ ] Unit test: move directory (verify children still accessible under new path)
- [ ] Unit test: move over existing file (verify old file's dirent removed)
- [ ] Typecheck passes

---

### Epic 4: SqlDialect — Blob & Bulk Operations

#### US-013: Postgres dialect — upsertBlob and getBlob
**Description:** As a developer, I want to store and retrieve file content as content-addressable blobs.

**Acceptance Criteria:**
- [ ] `upsertBlob(tx, sha256, data)` uses `INSERT INTO blobs ... ON CONFLICT (sha256) DO NOTHING`
- [ ] `getBlob(tx, sha256)` returns `Uint8Array` or null
- [ ] Blob sha256 computed server-side via `digest(data, 'sha256')` from pgcrypto
- [ ] Unit test: insert blob, retrieve by sha256, verify data matches
- [ ] Unit test: insert same content twice, verify only one row exists (dedup)
- [ ] Unit test: get non-existent sha256, returns null
- [ ] Typecheck passes

#### US-014: Postgres dialect — gcOrphanBlobs
**Description:** As a developer, I want to delete blobs not referenced by any inode.

**Acceptance Criteria:**
- [ ] `gcOrphanBlobs(tx)` deletes from blobs where sha256 not in any inode's content_sha256, returns count
- [ ] Unit test: create blob referenced by inode, GC, verify blob survives
- [ ] Unit test: delete inode, GC, verify orphan blob removed
- [ ] Unit test: blob referenced by two inodes, delete one inode, GC, verify blob survives
- [ ] Typecheck passes

#### US-015: Postgres dialect — loadAllPaths
**Description:** As a developer, I want to load the entire file tree for a sandbox in one query for pathCache initialization.

**Acceptance Criteria:**
- [ ] `loadAllPaths(tx)` uses recursive CTE starting from sandbox root inode
- [ ] Returns `PathCacheEntry[]` with full path string, inodeId, kind, mode, size, mtime, contentSha256, symlinkTarget
- [ ] Paths are absolute (e.g., `/home/user/file.txt`)
- [ ] Root directory included as `/`
- [ ] Unit test: create sandbox with nested files/dirs, call loadAllPaths, verify all paths present with correct metadata
- [ ] Typecheck passes

#### US-016: Postgres dialect — loadSubtreeInodes
**Description:** As a developer, I want to collect all inode IDs in a subtree for recursive delete.

**Acceptance Criteria:**
- [ ] `loadSubtreeInodes(tx, rootInodeId)` uses recursive CTE, returns array of all descendant inode IDs
- [ ] Includes the root itself
- [ ] Unit test: create dir with nested structure (3 levels deep), verify all inodes collected
- [ ] Typecheck passes

#### US-017: Postgres dialect — bulkIngest
**Description:** As a developer, I want to insert many files in a single transaction for fast ingest.

**Acceptance Criteria:**
- [ ] `bulkIngest(tx, files: { path, content, mode }[])` creates all parent dirs, inodes, dirents, and blobs in minimal round-trips
- [ ] Uses multi-row INSERT for blobs and inodes
- [ ] Resolves parent directories from pathCache or creates them
- [ ] Unit test: bulk ingest 50 files across 5 directories, verify all accessible via listDirents
- [ ] Typecheck passes

#### US-018: Postgres dialect — fs_resolve stored procedure
**Description:** As a developer, I want a plpgsql stored procedure that resolves a path string to an inode ID with symlink handling.

**Acceptance Criteria:**
- [ ] `fs_resolve(p_path TEXT, p_follow_last BOOLEAN)` function in Postgres
- [ ] Walks path components left-to-right, looking up each in `dirents`
- [ ] Follows symlinks on intermediate components always
- [ ] Follows symlink on last component only when `p_follow_last = true`
- [ ] Handles `.` (skip) and `..` (climb to parent) components
- [ ] Depth counter capped at 40 (raises SQLSTATE 'FS001' = ELOOP)
- [ ] Raises SQLSTATE 'FS002' when component not found (ENOENT)
- [ ] Raises SQLSTATE 'FS003' when traversing non-directory (ENOTDIR)
- [ ] Uses `current_setting('app.sandbox_id')` to find sandbox root
- [ ] `resolvePath(tx, components, followLast)` dialect method calls this proc
- [ ] Unit test: resolve simple path `/home/user/file.txt`
- [ ] Unit test: resolve path with `.` and `..` components
- [ ] Unit test: resolve path through symlink (intermediate)
- [ ] Unit test: resolve symlink at end with follow_last=true vs false
- [ ] Unit test: detect symlink loop (A→B→A), verify ELOOP
- [ ] Unit test: resolve non-existent path, verify ENOENT
- [ ] Unit test: resolve path where intermediate component is a file, verify ENOTDIR
- [ ] Typecheck passes

---

### Epic 5: SqlFs — Path Cache

#### US-019: pathCache initialization from loadAllPaths
**Description:** As a developer, I want the pathCache populated at session start so that stat/readdir/getAllPaths work without DB calls.

**Acceptance Criteria:**
- [ ] `SqlFs.ready()` calls `dialect.loadAllPaths()` inside a transaction with sandbox context
- [ ] Stores results in `this.pathCache: Map<string, PathCacheEntry>`
- [ ] `getAllPaths()` returns `[...this.pathCache.keys()]` (synchronous, no DB)
- [ ] Unit test (mocked dialect): ready() populates cache, getAllPaths() returns expected paths
- [ ] Typecheck passes

#### US-020: pathCache update on write operations
**Description:** As a developer, I want the pathCache updated whenever files are created, modified, or deleted so it stays in sync.

**Acceptance Criteria:**
- [ ] `writeFile` adds/updates entry in pathCache after successful DB write
- [ ] `mkdir` adds directory entry to pathCache
- [ ] `rm` removes entry from pathCache (and all descendants if recursive)
- [ ] `appendFile` updates size and mtime in pathCache entry
- [ ] `chmod` updates mode in pathCache entry
- [ ] `utimes` updates mtime in pathCache entry
- [ ] Unit test (mocked dialect): write file, verify pathCache has new entry; rm file, verify removed
- [ ] Typecheck passes

#### US-021: pathCache rebuild on mv
**Description:** As a developer, I want pathCache keys rebuilt when files/directories are moved so that old paths stop resolving and new paths work.

**Acceptance Criteria:**
- [ ] `mv(src, dest)` after dialect.moveDirent: removes all pathCache keys starting with `src`, re-inserts under `dest`
- [ ] For directory moves: all descendant keys are remapped (e.g., `/a/b/c` → `/x/b/c`)
- [ ] Unit test (mocked dialect): create dir with children in cache, mv, verify old paths gone, new paths present
- [ ] Typecheck passes

---

### Epic 6: SqlFs — Content Cache (LRU)

#### US-022: LRU content cache setup
**Description:** As a developer, I want an LRU cache for file content keyed by inode ID with a configurable byte budget.

**Acceptance Criteria:**
- [ ] `contentCache` initialized in SqlFs constructor using `lru-cache` package
- [ ] Max total size configurable via `contentCacheMaxBytes` option (default 50MB)
- [ ] Each entry's "size" is the byte length of the Uint8Array
- [ ] LRU eviction: oldest-accessed entries evicted first when budget exceeded
- [ ] Unit test: insert entries exceeding budget, verify oldest evicted
- [ ] Typecheck passes

#### US-023: Content cache hit on readFile
**Description:** As a developer, I want readFile to return cached content without hitting the database.

**Acceptance Criteria:**
- [ ] `readFile()` checks contentCache by inodeId before calling dialect.getBlob
- [ ] On cache hit: returns cached Uint8Array (decoded to string if encoding specified)
- [ ] On cache miss: calls dialect.getBlob, stores result in contentCache, returns
- [ ] Unit test (mocked dialect): first read calls getBlob, second read does not
- [ ] Typecheck passes

#### US-024: Content cache invalidation on write/delete
**Description:** As a developer, I want stale content evicted from cache when files are written or deleted.

**Acceptance Criteria:**
- [ ] `writeFile()` sets new content in contentCache (or deletes old + sets new if inodeId changed)
- [ ] `rm()` deletes entry from contentCache
- [ ] `appendFile()` deletes entry from contentCache (forces re-read on next access)
- [ ] `mv()` does NOT invalidate contentCache (same inodeId, same bytes)
- [ ] Unit test: write, read (cached), overwrite, read again (new content, not stale)
- [ ] Typecheck passes

---

### Epic 7: SqlFs — IFileSystem Read Methods

#### US-025: SqlFs.stat and SqlFs.lstat
**Description:** As a developer, I want stat/lstat served from pathCache.

**Acceptance Criteria:**
- [ ] `stat(path)` normalizes path, looks up pathCache, returns `FsStat` with `isFile`, `isDirectory`, `isSymbolicLink=false` (stat always follows)
- [ ] `lstat(path)` same but `isSymbolicLink=true` when kind=3
- [ ] Throws ENOENT if path not in cache
- [ ] Symlink at final component: `stat` follows (looks up target in cache), `lstat` returns symlink's own metadata
- [ ] Unit test: stat file, dir, symlink; lstat symlink returns isSymbolicLink=true
- [ ] Typecheck passes

#### US-026: SqlFs.exists
**Description:** As a developer, I want exists() served from pathCache without throwing.

**Acceptance Criteria:**
- [ ] `exists(path)` returns `true` if path in pathCache, `false` otherwise
- [ ] Never throws
- [ ] Unit test: existing path returns true, non-existing returns false
- [ ] Typecheck passes

#### US-027: SqlFs.readdir and readdirWithFileTypes
**Description:** As a developer, I want readdir served from pathCache by filtering child paths.

**Acceptance Criteria:**
- [ ] `readdir(path)` returns array of child names (not full paths) by filtering pathCache keys where key starts with `path + '/'` and has no further `/`
- [ ] Throws ENOENT if path not in cache
- [ ] Throws ENOTDIR if path is a file
- [ ] `readdirWithFileTypes(path)` returns `DirentEntry[]` with `name`, `isFile`, `isDirectory`, `isSymbolicLink`
- [ ] Unit test: dir with 3 children (file, dir, symlink), verify names and types
- [ ] Unit test: readdir on non-existent path throws ENOENT
- [ ] Unit test: readdir on file throws ENOTDIR
- [ ] Typecheck passes

#### US-028: SqlFs.readFile and readFileBuffer
**Description:** As a developer, I want readFile to check content cache then fall back to DB.

**Acceptance Criteria:**
- [ ] `readFile(path, options?)` resolves path via pathCache, checks contentCache, falls back to `dialect.getBlob`
- [ ] Throws ENOENT if path not in cache
- [ ] Throws EISDIR if kind=2
- [ ] Returns string decoded from Uint8Array (default utf8, configurable encoding)
- [ ] `readFileBuffer(path)` returns raw Uint8Array
- [ ] Stores fetched content in contentCache on miss
- [ ] Unit test: read existing file, read non-existent (ENOENT), read directory (EISDIR)
- [ ] Typecheck passes

#### US-029: SqlFs.readlink
**Description:** As a developer, I want readlink to return symlink target from pathCache.

**Acceptance Criteria:**
- [ ] `readlink(path)` looks up path in pathCache, returns `symlinkTarget`
- [ ] Throws EINVAL if path is not a symlink (kind != 3)
- [ ] Throws ENOENT if path not in cache
- [ ] Unit test: readlink on symlink returns target string, readlink on file throws EINVAL
- [ ] Typecheck passes

#### US-030: SqlFs.realpath
**Description:** As a developer, I want realpath to resolve all symlinks via the dialect's path resolver.

**Acceptance Criteria:**
- [ ] `realpath(path)` calls `dialect.resolvePath(tx, components, followLast=true)` and reconstructs the canonical path
- [ ] Returns absolute path with all symlinks resolved
- [ ] Throws ENOENT if any component missing, ELOOP if circular symlinks
- [ ] Unit test: realpath through symlink returns resolved target path
- [ ] Typecheck passes

---

### Epic 8: SqlFs — IFileSystem Write Methods

#### US-031: SqlFs.writeFile
**Description:** As a developer, I want writeFile to persist content as a deduplicated blob and update caches.

**Acceptance Criteria:**
- [ ] Computes sha256 of content
- [ ] Calls `dialect.upsertBlob` (dedup)
- [ ] Resolves parent from pathCache, throws ENOENT if parent missing
- [ ] Creates new inode via `dialect.createInode(kind=1)`
- [ ] Calls `dialect.upsertDirent` — if replacing, decrements old inode's nlink
- [ ] Updates pathCache with new entry
- [ ] Updates contentCache with new content
- [ ] Unit test: write new file, verify in pathCache + contentCache
- [ ] Unit test: overwrite existing file, verify old inode cleaned up
- [ ] Unit test: write to non-existent parent dir throws ENOENT
- [ ] Typecheck passes

#### US-032: SqlFs.appendFile
**Description:** As a developer, I want appendFile to read current content, append, and write back.

**Acceptance Criteria:**
- [ ] If file exists: reads current content (from cache or DB), appends new content, writes back as new blob
- [ ] If file doesn't exist: creates new file with the appended content
- [ ] Updates pathCache (new size, mtime, contentSha256)
- [ ] Invalidates old contentCache entry, sets new one
- [ ] Unit test: append to existing file, verify content is original + appended
- [ ] Unit test: append to non-existent file, verify file created
- [ ] Typecheck passes

#### US-033: SqlFs.mkdir
**Description:** As a developer, I want mkdir to create directory inodes with optional recursive mode.

**Acceptance Criteria:**
- [ ] Non-recursive: creates single dir, throws ENOENT if parent missing, throws EEXIST if already exists
- [ ] Recursive: creates all missing parent directories, silently succeeds if already exists
- [ ] Each created directory added to pathCache
- [ ] Unit test: mkdir single level, mkdir -p nested, mkdir existing (EEXIST), mkdir -p existing (no error)
- [ ] Typecheck passes

#### US-034: SqlFs.rm (non-recursive)
**Description:** As a developer, I want rm to remove a single file or empty directory.

**Acceptance Criteria:**
- [ ] Removes dirent via `dialect.deleteDirent`
- [ ] Decrements inode nlink via `dialect.decrementNlink`
- [ ] If nlink reaches 0, deletes inode via `dialect.deleteInode`
- [ ] Throws ENOENT if path doesn't exist (unless force=true)
- [ ] Throws ENOTEMPTY if directory has children
- [ ] Throws EISDIR if path is directory and recursive not set
- [ ] Removes entry from pathCache and contentCache
- [ ] Unit test: rm file, rm empty dir, rm non-empty dir (ENOTEMPTY), rm non-existent (ENOENT), rm -f non-existent (no error)
- [ ] Typecheck passes

#### US-035: SqlFs.rm (recursive)
**Description:** As a developer, I want rm -r to remove a directory and all its contents.

**Acceptance Criteria:**
- [ ] Collects all descendant inode IDs via `dialect.loadSubtreeInodes`
- [ ] Deletes all dirents and inodes in the subtree within one transaction
- [ ] Removes all subtree paths from pathCache
- [ ] Removes all subtree inodes from contentCache
- [ ] Unit test: create nested structure (3 levels), rm -r root, verify all gone from DB and caches
- [ ] Typecheck passes

#### US-036: SqlFs.mv
**Description:** As a developer, I want mv to rename/move via single dirent update and rebuild pathCache keys.

**Acceptance Criteria:**
- [ ] Calls `dialect.moveDirent(oldParent, oldName, newParent, newName)` — single row UPDATE
- [ ] If destination exists: removes existing dirent + decrements its inode nlink first
- [ ] Rebuilds pathCache: removes all keys under old path, re-inserts under new path
- [ ] Does NOT invalidate contentCache (same inodeIds, same content)
- [ ] Unit test: rename file, move file to different dir, move directory with children
- [ ] Unit test: move over existing file (destination replaced)
- [ ] Typecheck passes

#### US-037: SqlFs.cp (non-recursive, single file)
**Description:** As a developer, I want cp to copy a file by creating a new inode pointing to the same blob.

**Acceptance Criteria:**
- [ ] Creates new inode with same contentSha256 as source (no blob duplication)
- [ ] Inserts new dirent at destination
- [ ] Throws ENOENT if source doesn't exist
- [ ] Updates pathCache with new entry
- [ ] Unit test: cp file, verify dest has same content, verify only one blob row
- [ ] Typecheck passes

#### US-038: SqlFs.cp (recursive, directory)
**Description:** As a developer, I want cp -r to deep-copy a directory tree.

**Acceptance Criteria:**
- [ ] Recursively walks source subtree, creates new inode per entry (sharing contentSha256 for files)
- [ ] Creates new dirents mirroring the source structure
- [ ] Adds all new paths to pathCache
- [ ] Throws error if recursive not set and source is directory
- [ ] Unit test: cp -r dir with nested files/dirs, verify full tree duplicated, blobs shared
- [ ] Typecheck passes

#### US-039: SqlFs.link (hardlink)
**Description:** As a developer, I want link() to create a second directory entry pointing to the same inode.

**Acceptance Criteria:**
- [ ] Inserts new dirent pointing to existing inode
- [ ] Increments nlink on the inode
- [ ] Throws if source is a directory (hardlinks to dirs not allowed)
- [ ] Throws if destination already exists
- [ ] Adds new path to pathCache
- [ ] Unit test: create hardlink, verify both paths resolve to same content, nlink=2
- [ ] Typecheck passes

#### US-040: SqlFs.symlink
**Description:** As a developer, I want symlink() to create a symlink inode, respecting default-deny policy.

**Acceptance Criteria:**
- [ ] If `allowSymlinks=false` (default): throws EPERM immediately, no DB call
- [ ] If `allowSymlinks=true`: creates kind=3 inode with `symlinkTarget`, inserts dirent
- [ ] Adds to pathCache with kind=3
- [ ] Unit test: symlink with allowSymlinks=false throws EPERM
- [ ] Unit test: symlink with allowSymlinks=true creates entry, readlink returns target
- [ ] Typecheck passes

#### US-041: SqlFs.chmod and SqlFs.utimes
**Description:** As a developer, I want chmod/utimes to update inode metadata and pathCache.

**Acceptance Criteria:**
- [ ] `chmod(path, mode)` calls `dialect.updateInode(tx, inodeId, { mode })`, updates pathCache entry
- [ ] `utimes(path, atime, mtime)` calls `dialect.updateInode(tx, inodeId, { mtime })`, updates pathCache entry
- [ ] Both throw ENOENT if path not found
- [ ] Unit test: chmod changes mode, utimes changes mtime, both reflected in subsequent stat()
- [ ] Typecheck passes

#### US-042: SqlFs.resolvePath (synchronous)
**Description:** As a developer, I want resolvePath to do pure path joining without any DB call.

**Acceptance Criteria:**
- [ ] Uses `resolvePath` from `src/fs/path-utils.ts` directly
- [ ] Synchronous, no async, no DB
- [ ] `resolvePath("/home/user", "project/src")` → `"/home/user/project/src"`
- [ ] `resolvePath("/home/user", "/tmp")` → `"/tmp"` (absolute overrides)
- [ ] Unit test: relative path, absolute path, `.` and `..` handling
- [ ] Typecheck passes

---

> **DEFERRED TO FUTURE ROADMAP.** Epics 9, 10, and 11 (MySQL, Azure SQL, Azure FileShare backends) are documented below for future implementation but are NOT part of V1. V1 ships with Postgres only. The `SqlDialect` interface (US-001) was designed to accommodate these dialects, so adding them later is additive and does not require refactoring core SqlFs code. When picking this up, follow the user stories as written — they remain accurate.

### Epic 9: MySQL Dialect *(future roadmap — not V1)*

#### US-043: MySQL dialect — connection and sandbox context
**Description:** As a developer, I want the MySQL dialect to connect via `mysql2` and set sandbox context per transaction.

**Acceptance Criteria:**
- [ ] `MySqlDialect` class in `src/fs/sql-fs/dialects/mysql.ts`
- [ ] Uses `mysql2/promise` pool
- [ ] `setSandboxContext(tx, sandboxId)` executes `SET @sandbox_id = ?`
- [ ] All queries include `WHERE sandbox_id = @sandbox_id` (no RLS)
- [ ] Unit test: connect, set context, verify session variable
- [ ] Typecheck passes

#### US-044: MySQL dialect — schema differences
**Description:** As a developer, I want MySQL-specific DDL adaptations (AUTO_INCREMENT, LONGBLOB, etc.).

**Acceptance Criteria:**
- [ ] Migration file for MySQL with: `BIGINT AUTO_INCREMENT`, `LONGBLOB`, `DATETIME(6)`, `SHA2(data, 256)`
- [ ] `upsertDirent` uses `INSERT ... ON DUPLICATE KEY UPDATE`
- [ ] `upsertBlob` uses `INSERT ... ON DUPLICATE KEY UPDATE` (MySQL has no `ON CONFLICT`)
- [ ] Unit test: create tables, insert data, verify types
- [ ] Typecheck passes

#### US-045: MySQL dialect — fs_resolve stored procedure
**Description:** As a developer, I want the path resolution procedure ported to MySQL.

**Acceptance Criteria:**
- [ ] MySQL stored procedure `fs_resolve` with equivalent logic to Postgres version
- [ ] Uses `SIGNAL SQLSTATE '45001'` for ELOOP, `'45002'` for ENOENT, `'45003'` for ENOTDIR
- [ ] Symlink handling with 40-hop depth limit
- [ ] Unit test: same path resolution scenarios as US-018
- [ ] Typecheck passes

#### US-046: MySQL dialect — all remaining CRUD methods
**Description:** As a developer, I want all remaining SqlDialect methods implemented for MySQL.

**Acceptance Criteria:**
- [ ] `createInode`, `getInode`, `updateInode`, `deleteInode` using MySQL syntax
- [ ] `incrementNlink`, `decrementNlink` with `LAST_INSERT_ID(nlink-1)` pattern for returning new value
- [ ] `insertDirent`, `deleteDirent`, `listDirents`, `moveDirent`
- [ ] `getBlob`, `gcOrphanBlobs`, `loadAllPaths`, `loadSubtreeInodes`, `bulkIngest`
- [ ] Unit tests for each method (can mirror Postgres tests)
- [ ] Typecheck passes

---

### Epic 10: Azure SQL Dialect *(future roadmap — not V1)*

#### US-047: Azure SQL dialect — connection and sandbox context
**Description:** As a developer, I want the Azure SQL dialect to connect via `mssql` and set sandbox context via SESSION_CONTEXT.

**Acceptance Criteria:**
- [ ] `AzureSqlDialect` class in `src/fs/sql-fs/dialects/azure-sql.ts`
- [ ] Uses `mssql` (tedious) connection pool
- [ ] `setSandboxContext(tx, sandboxId)` executes `EXEC sp_set_session_context 'sandbox_id', @id`
- [ ] RLS policies use `SESSION_CONTEXT(N'sandbox_id')`
- [ ] Unit test: connect, set context, verify session context value
- [ ] Typecheck passes

#### US-048: Azure SQL dialect — schema differences
**Description:** As a developer, I want Azure SQL-specific DDL adaptations (IDENTITY, VARBINARY(MAX), etc.).

**Acceptance Criteria:**
- [ ] Migration file for Azure SQL with: `BIGINT IDENTITY(1,1)`, `VARBINARY(MAX)`, `DATETIMEOFFSET`, `HASHBYTES('SHA2_256', data)`
- [ ] `upsertDirent` uses `MERGE` statement
- [ ] RLS policies created with `CREATE SECURITY POLICY`
- [ ] Unit test: create tables, insert data, verify types
- [ ] Typecheck passes

#### US-049: Azure SQL dialect — fs_resolve stored procedure
**Description:** As a developer, I want the path resolution procedure ported to T-SQL.

**Acceptance Criteria:**
- [ ] T-SQL stored procedure `fs_resolve` with equivalent logic
- [ ] Uses `THROW 50001, 'ELOOP', 1` for custom errors
- [ ] Uses `STRING_SPLIT` or cursor for component walking
- [ ] Unit test: same path resolution scenarios as US-018
- [ ] Typecheck passes

#### US-050: Azure SQL dialect — all remaining CRUD methods
**Description:** As a developer, I want all remaining SqlDialect methods implemented for Azure SQL.

**Acceptance Criteria:**
- [ ] All CRUD methods using T-SQL syntax
- [ ] `MERGE` for upsert operations
- [ ] `OUTPUT` clause for returning affected rows
- [ ] `loadAllPaths` using recursive CTE (no `WITH RECURSIVE` keyword needed in T-SQL)
- [ ] Unit tests for each method
- [ ] Typecheck passes

---

### Epic 11: Azure FileShare Backend *(future roadmap — not V1)*

#### US-051: FileShare sandbox directory creation
**Description:** As a developer, I want a FileShare-backed sandbox to create an isolated subdirectory with default structure.

**Acceptance Criteria:**
- [ ] Given `mountPath` and `sandboxId`, creates `${mountPath}/${sandboxId}/` with `home/user`, `tmp`, `bin` subdirs
- [ ] Returns `ReadWriteFs({ root: sandboxDir })` — no new class
- [ ] Unit test (using OS temp dir): verify directory structure created
- [ ] Typecheck passes

#### US-052: FileShare sandbox deletion
**Description:** As a developer, I want FileShare sandbox cleanup to remove the subdirectory.

**Acceptance Criteria:**
- [ ] `destroySandbox` removes `${mountPath}/${sandboxId}/` recursively
- [ ] No-op if directory doesn't exist
- [ ] Unit test: create then destroy, verify directory gone
- [ ] Typecheck passes

---

### Epic 12: Factory & Configuration

#### US-053: createSandboxFs factory function
**Description:** As a developer, I want a single function that creates the right IFileSystem from a config object.

**Acceptance Criteria:**
- [ ] `createSandboxFs(backend: StorageBackend, sandboxId: string): Promise<IFileSystem>`
- [ ] Handles `postgres`, `mysql`, `azure-sql` → creates dialect + SqlFs + calls ready()
- [ ] Handles `azure-fileshare` → creates directory + returns ReadWriteFs
- [ ] Handles `memory` → returns InMemoryFs
- [ ] Unit test: factory with memory backend returns InMemoryFs
- [ ] Typecheck passes

#### US-054: Environment variable configuration
**Description:** As a developer, I want backend selection via environment variables.

**Acceptance Criteria:**
- [ ] `loadBackendConfig()` reads `FS_BACKEND` (required), `DATABASE_URL` (for SQL), `FS_MOUNT_PATH` (for FileShare)
- [ ] Throws descriptive error if required vars missing for selected backend
- [ ] Unit test: mock env vars, verify correct StorageBackend returned
- [ ] Typecheck passes

#### US-055: destroySandbox function
**Description:** As a developer, I want a companion function to clean up a sandbox's persistent data.

**Acceptance Criteria:**
- [ ] `destroySandbox(backend: StorageBackend, sandboxId: string): Promise<void>`
- [ ] SQL backends: CASCADE delete from sandboxes table
- [ ] FileShare: rm -rf the sandbox directory
- [ ] Memory: no-op
- [ ] Unit test: create then destroy for each backend type
- [ ] Typecheck passes

---

### Epic 13: HTTP API — Server Setup & Auth

#### US-056: Hono server bootstrap
**Description:** As a developer, I want the Hono HTTP server initialized with middleware and error handling.

**Acceptance Criteria:**
- [ ] `api/src/server.ts` creates Hono app
- [ ] JSON body parsing middleware
- [ ] Request logging middleware (structured JSON)
- [ ] Global error handler: catches errors, returns `{ error, code }` JSON with appropriate status
- [ ] `GET /healthz` returns 200 `{ status: "ok" }`
- [ ] `GET /readyz` returns 200 when DB connection healthy, 503 otherwise
- [ ] Server listens on `PORT` env var (default 8080)
- [ ] Unit test: healthz returns 200
- [ ] Typecheck passes

#### US-057: JWT/HMAC auth middleware
**Description:** As a developer, I want auth middleware that verifies JWT tokens (HMAC-SHA256) signed with `AUTH_SECRET` and extracts the owner identity from the `sub` claim.

**Acceptance Criteria:**
- [ ] `api/src/auth.ts` exports Hono middleware
- [ ] Extracts `Authorization: Bearer <token>` header
- [ ] Verifies JWT signature using `AUTH_SECRET` env var with HS256 algorithm
- [ ] Rejects expired tokens (checks `exp` claim if present)
- [ ] Extracts `sub` claim as owner identity, sets `c.set('owner', sub)` for downstream use
- [ ] Returns 401 `{ error: "unauthorized", code: "AUTH_REQUIRED" }` if token missing
- [ ] Returns 401 `{ error: "invalid_token", code: "AUTH_INVALID" }` if signature invalid or expired
- [ ] Applied to all `/v1/*` routes (not `/healthz`, `/readyz`, `/mcp`)
- [ ] Uses `jose` library (zero-dependency JOSE implementation) for JWT verification — no `jsonwebtoken` (it pulls in 10+ transitive deps)
- [ ] Unit test: valid token passes with correct `sub`, expired token returns 401, tampered token returns 401, missing header returns 401
- [ ] Typecheck passes

#### US-057b: Token generation CLI (local dev / bootstrap)
**Description:** As an operator, I want a local CLI command to generate the initial admin JWT token so I can bootstrap access before the API is deployed.

**Acceptance Criteria:**
- [ ] `pnpm token:create -- --sub agent-1 --expires 30d` generates and prints a JWT
- [ ] `api/src/cli/token.ts` script using `jose` to sign with `AUTH_SECRET`
- [ ] Accepts `--sub <identity>` (required) and `--expires <duration>` (optional, default: no expiry)
- [ ] Duration supports: `30d`, `1y`, `24h`, `never`
- [ ] Prints only the token string to stdout (for easy piping)
- [ ] Errors if `AUTH_SECRET` env var not set
- [ ] Typecheck passes

#### US-057c: Token generation admin endpoint (production)
**Description:** As an operator, I want an API endpoint to generate JWT tokens for agents/clients so I can issue tokens without needing the source code or local CLI — just the running container and an existing valid token.

**Acceptance Criteria:**
- [ ] `POST /v1/admin/tokens` endpoint in `api/src/routes/admin.ts`
- [ ] Requires valid JWT auth (any authenticated user can create tokens — scope down later if needed)
- [ ] Body: `{ sub: string, expiresIn?: string }` validated by zod
- [ ] `sub` is required, identifies the new token's owner
- [ ] `expiresIn` is optional, supports `30d`, `1y`, `24h`, `never` (default: `30d`)
- [ ] Returns 201 `{ token: string, sub: string, expiresAt: string | null }`
- [ ] Token signed with same `AUTH_SECRET` the server uses for verification
- [ ] Unit test: create token via endpoint, use returned token to call another endpoint, verify it works
- [ ] Unit test: missing `sub` returns 400, invalid `expiresIn` returns 400
- [ ] Typecheck passes

#### US-058: Zod request validation middleware
**Description:** As a developer, I want reusable zod validation for request bodies and query params.

**Acceptance Criteria:**
- [ ] `api/src/validation.ts` exports `validateBody(schema)` and `validateQuery(schema)` middleware factories
- [ ] On validation failure: returns 400 `{ error: "validation_error", code: "INVALID_INPUT", details: [...] }`
- [ ] Unit test: valid body passes, invalid body returns 400 with field-level details
- [ ] Typecheck passes

---

### Epic 14: HTTP API — Sandbox CRUD

#### US-059: POST /v1/sandboxes — create sandbox
**Description:** As an API consumer, I want to create a new sandbox.

**Acceptance Criteria:**
- [ ] Body: `{ env?: Record<string,string>, files?: Record<string,string> }` (optional initial state)
- [ ] Creates sandbox in DB/FileShare via factory
- [ ] Returns 201 `{ id, createdAt }`
- [ ] Sandbox `owner` set from auth token
- [ ] Unit test: create sandbox, verify 201 response with id
- [ ] Typecheck passes

> Future extension (see US-080a): body will also accept `python?: boolean` and `javascript?: boolean` to opt in to WASM runtimes at sandbox creation time.

#### US-060: GET /v1/sandboxes/:id — get sandbox info
**Description:** As an API consumer, I want to inspect sandbox metadata.

**Acceptance Criteria:**
- [ ] Returns 200 `{ id, owner, createdAt, lastUsedAt }`
- [ ] Returns 404 if sandbox doesn't exist
- [ ] Returns 403 if sandbox belongs to different owner
- [ ] Unit test: get existing, get non-existent (404), get other owner's (403)
- [ ] Typecheck passes

#### US-061: DELETE /v1/sandboxes/:id — delete sandbox
**Description:** As an API consumer, I want to destroy a sandbox and all its data.

**Acceptance Criteria:**
- [ ] Evicts session from SessionManager
- [ ] Calls `destroySandbox()` on backend
- [ ] Returns 204 (no body)
- [ ] Returns 404 if sandbox doesn't exist
- [ ] Unit test: create, delete, verify gone
- [ ] Typecheck passes

---

### Epic 15: HTTP API — File Operations

#### US-062: GET /v1/sandboxes/:id/files/*path — read file
**Description:** As an API consumer, I want to download a file's content from a sandbox.

**Acceptance Criteria:**
- [ ] Returns raw bytes with `Content-Type` inferred from extension (or `application/octet-stream`)
- [ ] `X-FS-Stat` response header: JSON `{ kind, mode, size, mtime }`
- [ ] Returns 404 for ENOENT
- [ ] Returns 400 if path is a directory (use `/tree` for directories)
- [ ] Unit test: read existing file, read non-existent (404), read directory (400)
- [ ] Typecheck passes

#### US-063: PUT /v1/sandboxes/:id/files/*path — write file
**Description:** As an API consumer, I want to upload/overwrite a file in a sandbox.

**Acceptance Criteria:**
- [ ] Request body = raw file content
- [ ] Creates parent directories if they don't exist (mkdir -p behavior)
- [ ] Returns 204
- [ ] Unit test: write new file, overwrite existing, verify content via GET
- [ ] Typecheck passes

#### US-064: DELETE /v1/sandboxes/:id/files/*path — delete file or dir
**Description:** As an API consumer, I want to remove a file or directory from a sandbox.

**Acceptance Criteria:**
- [ ] Query param `recursive=true` for directory removal
- [ ] Returns 204
- [ ] Returns 404 for ENOENT
- [ ] Returns 409 for ENOTEMPTY (directory without recursive flag)
- [ ] Unit test: delete file, delete empty dir, delete non-empty dir without recursive (409), delete with recursive
- [ ] Typecheck passes

#### US-065: POST /v1/sandboxes/:id/mkdir — create directory
**Description:** As an API consumer, I want to create a directory in a sandbox.

**Acceptance Criteria:**
- [ ] Body: `{ path: string, recursive?: boolean }`
- [ ] Returns 204
- [ ] Returns 409 if already exists (without recursive)
- [ ] Unit test: mkdir, mkdir -p, mkdir existing (409)
- [ ] Typecheck passes

#### US-066: POST /v1/sandboxes/:id/writeFiles — bulk write
**Description:** As an API consumer, I want to write multiple files in one request.

**Acceptance Criteria:**
- [ ] Body: `{ files: { [path: string]: string } }`
- [ ] Creates all parent directories as needed
- [ ] Returns 204
- [ ] Unit test: write 5 files in one call, verify all readable
- [ ] Typecheck passes

#### US-067: GET /v1/sandboxes/:id/tree — list file tree
**Description:** As an API consumer, I want to list all files under a path with metadata.

**Acceptance Criteria:**
- [ ] Query params: `prefix` (default `/`), `depth` (default unlimited)
- [ ] Returns JSON array: `[{ path, kind, size, mtime }]`
- [ ] `depth=1` returns only direct children
- [ ] Unit test: tree of nested structure, tree with depth limit
- [ ] Typecheck passes

---

### Epic 16: HTTP API — Bash Execution

#### US-068: POST /v1/sandboxes/:id/exec-sync — buffered execution
**Description:** As an API consumer, I want to run a bash script and get the full result as JSON.

**Acceptance Criteria:**
- [ ] Body: `{ script: string, cwd?: string, env?: Record<string,string>, stdin?: string, timeoutMs?: number }`
- [ ] Returns 200 `{ stdout, stderr, exitCode }`
- [ ] Default timeout 30s, max 300s
- [ ] Returns 408 on timeout
- [ ] Unit test: echo hello → stdout="hello\n", false → exitCode=1, timeout → 408
- [ ] Typecheck passes

#### US-069: POST /v1/sandboxes/:id/exec — SSE streaming execution
**Description:** As an API consumer, I want to run a bash script and stream output via Server-Sent Events.

**Acceptance Criteria:**
- [ ] Same body as exec-sync
- [ ] Response: `Content-Type: text/event-stream`
- [ ] Events: `stdout` (`{ t:"stdout", data }` ), `stderr` (`{ t:"stderr", data }`), `exit` (`{ t:"exit", exitCode, durationMs }`)
- [ ] Client disconnect triggers AbortController to cancel execution
- [ ] Unit test: execute script, collect all SSE events, verify stdout + exit event
- [ ] Typecheck passes

#### US-070: Exec timeout enforcement
**Description:** As a developer, I want exec to be aborted if it exceeds the timeout.

**Acceptance Criteria:**
- [ ] AbortController created per request with `setTimeout(abort, timeoutMs)`
- [ ] Passed to `bash.exec(script, { signal })` which just-bash already supports
- [ ] Timer cleared after execution completes
- [ ] Returns 408 for sync, sends `exit` event with special code for SSE
- [ ] Unit test: script that sleeps longer than timeout, verify cancellation
- [ ] Typecheck passes

---

### Epic 17: HTTP API — Ingest & Export

#### US-071: POST /v1/sandboxes/:id/ingest — tar.gz upload
**Description:** As an API consumer, I want to upload a tar.gz archive and extract it into the sandbox.

**Acceptance Criteria:**
- [ ] Multipart form: `archive` (tar.gz file), `basePath` (string, default `/home/user/project`)
- [ ] Writes archive to sandbox FS at `/tmp/_ingest.tar.gz`
- [ ] Runs `mkdir -p $basePath && cd $basePath && tar xzf /tmp/_ingest.tar.gz && rm /tmp/_ingest.tar.gz` via bash.exec
- [ ] Returns 200 `{ status: "ok", basePath }`
- [ ] Unit test: ingest tar.gz of 3 files, verify files readable in sandbox
- [ ] Typecheck passes

#### US-072: POST /v1/sandboxes/:id/ingest-files — JSON manifest upload
**Description:** As an API consumer, I want to upload files via JSON for small/programmatic uploads.

**Acceptance Criteria:**
- [ ] Body: `{ basePath: string, files: { [relativePath: string]: string } }` (content is base64 encoded)
- [ ] Decodes each file, writes to `basePath + '/' + relativePath`
- [ ] Creates parent directories as needed
- [ ] Returns 200 `{ status: "ok", fileCount }`
- [ ] Unit test: ingest 3 files via JSON, verify content matches after base64 decode
- [ ] Typecheck passes

#### US-073: GET /v1/sandboxes/:id/export — tar.gz download
**Description:** As an API consumer, I want to download sandbox contents as a tar.gz archive.

**Acceptance Criteria:**
- [ ] Query param: `basePath` (default `/home/user`)
- [ ] Runs `tar czf /tmp/_export.tar.gz -C $basePath .` via bash.exec
- [ ] Reads archive bytes from sandbox FS, deletes temp file
- [ ] Returns `Content-Type: application/gzip` with `Content-Disposition: attachment`
- [ ] Unit test: write files to sandbox, export, verify tar.gz contains expected files
- [ ] Typecheck passes

---

### Epic 18: Session Manager

#### US-074: Session manager — get or create session
**Description:** As a developer, I want the session manager to return one warm session per `sandboxId` (per API process) or create it on demand, so concurrent requests reuse the same `SqlFs` caches and warm Bash runtime safely.

**Acceptance Criteria:**
- [ ] Internal `Map<string, Session>` keyed by `sandboxId`; `Session` contains at minimum `{ fs, bash, lastUsed, inFlight, mutex, state }`
- [ ] `getOrCreate(sandboxId)` checks internal Map for existing session
- [ ] If found: updates `lastUsed`, returns the same warm session instance
- [ ] If not found: calls `createSandboxFs(backend, sandboxId)`, awaits `fs.ready()`, creates `new Bash({ fs })`, stores the new session in the Map
- [ ] Session creation is single-flight: if two concurrent requests miss the same `sandboxId`, only one actual session is created and both callers receive the same instance
- [ ] Public API includes `withSession(sandboxId, fn)` (or equivalent) so route handlers execute work through the manager instead of directly holding raw shared session objects
- [ ] `withSession(...)` serializes all same-sandbox operations through a per-sandbox async mutex; later requests wait for earlier ones to finish instead of mutating shared `pathCache`, `contentCache`, or warm Bash state concurrently
- [ ] When a waiting request begins, it observes the latest state left by prior completed requests (no same-process cache invalidation gap for the shared session)
- [ ] Unit test: first get creates, second get reuses same instance
- [ ] Unit test: two concurrent cache misses for the same `sandboxId` create exactly one session
- [ ] Unit test: two concurrent operations for the same `sandboxId` run in order, not in parallel
- [ ] Typecheck passes

#### US-075: Session manager — idle eviction
**Description:** As a developer, I want idle sessions evicted after a configurable timeout.

**Acceptance Criteria:**
- [ ] Background interval (every 60s) checks `lastUsed` against `SESSION_IDLE_MS` (default 10 min)
- [ ] Evicts sessions only when `Date.now() - lastUsed > idleMs` AND `inFlight === 0` AND session state is not `closing`
- [ ] Sessions with a running or queued same-sandbox operation are never evicted mid-flight; the reaper skips them and can retry on the next sweep
- [ ] Does NOT call destroySandbox on eviction (sandbox data persists, only in-memory Bash dropped)
- [ ] `startReaper()` / `stopReaper()` methods for lifecycle
- [ ] Unit test: create session, advance time past idle threshold, verify evicted
- [ ] Unit test: busy session past idle threshold is NOT evicted
- [ ] Typecheck passes

#### US-075a: Session manager — pathCache memory budget
**Description:** As a developer, I want each warm session's `pathCache` bounded by a configurable byte budget so large sandboxes cannot retain unbounded path metadata in process memory.

**Acceptance Criteria:**
- [ ] `pathCache` has a configurable max total size via `pathCacheMaxBytes` / env config, default 50MB per session
- [ ] Session creation measures or estimates total `pathCache` memory after `fs.ready()` using path string bytes plus cached metadata footprint per entry
- [ ] `pathCache` updates on write/delete/move also update the tracked byte estimate
- [ ] If the estimated `pathCache` size exceeds the configured budget, the current request still completes correctly, but the over-budget warm session is not retained once idle (no partial path eviction that would leave an incomplete tree snapshot)
- [ ] Unit test: under-budget session stays resident; over-budget session is marked non-retainable and is evicted when idle
- [ ] Typecheck passes

#### US-076a: Session manager — withExistingSession (no auto-create)
**Description:** As a developer, I want a `withExistingSession` method that fails with ENOENT instead of silently creating a new sandbox, so that operation routes (file ops, exec, ingest, export) reject requests for non-existent sandbox IDs instead of creating orphaned, ownerless sandboxes.

**Acceptance Criteria:**
- [ ] `SessionManager.withExistingSession(sandboxId, fn)` looks up an existing session via `getSession()`; if not found, throws an error with `code: "ENOENT"` and message indicating sandbox not found — it must NOT call `getOrCreate()`
- [ ] If the session exists but is in `closing` state, throws `ESESSIONCLOSING` (same as current `withSession` behavior)
- [ ] All HTTP operation routes (`routes/files.ts`, `routes/exec.ts`, `routes/ingest.ts`) are migrated from `withSession` to `withExistingSession`; only `POST /v1/sandboxes` (create) continues to use `withSession`/`getOrCreate`
- [ ] MCP tools `bash_exec`, `fs_ingest`, `fs_export` are migrated to `withExistingSession`; only `sandbox_create` uses `getOrCreate`
- [ ] Route-level error handlers map `ENOENT` from `withExistingSession` to HTTP 404 `{ error: "not_found", code: "SANDBOX_NOT_FOUND" }`
- [ ] MCP tool handlers map `ENOENT` from `withExistingSession` to `{ ok: false, error: "sandbox not found" }`
- [ ] Unit test: `withExistingSession` with non-existent ID throws ENOENT
- [ ] Unit test: `withExistingSession` with existing ID succeeds
- [ ] Unit test: HTTP `POST /v1/sandboxes/:id/exec-sync` with non-existent ID returns 404 (not auto-created)
- [ ] Unit test: MCP `bash_exec` with non-existent ID returns error (not auto-created)
- [ ] Typecheck passes
- [ ] Tests pass

#### US-076: Session manager — explicit destroy
**Description:** As a developer, I want to explicitly destroy a session and its backend data, while preventing new requests from attaching during teardown.

**Acceptance Criteria:**
- [ ] `destroy(sandboxId)` marks the session as `closing` before backend deletion so no new work can attach to it
- [ ] `destroy(sandboxId)` removes from Map AND calls `destroySandbox(backend, sandboxId)`
- [ ] If a session has in-flight work, destroy waits for the active operation to finish before tearing down the backend data
- [ ] Requests arriving after destroy has started fail fast (or are otherwise rejected) instead of creating a fresh warm session during teardown
- [ ] No-op if session doesn't exist in Map (still calls destroySandbox for DB cleanup)
- [ ] Concurrent destroy calls are idempotent; backend cleanup happens once
- [ ] Unit test: destroy active session, verify removed from Map and backend cleanup called
- [ ] Unit test: destroy waits for in-flight work, then cleans up
- [ ] Unit test: request arriving during destroy is rejected and does not recreate the session
- [ ] Typecheck passes

---

### Epic 19: MCP Server

#### US-077: MCP server setup and transport
**Description:** As a developer, I want an MCP server using streamable HTTP transport.

**Acceptance Criteria:**
- [ ] `api/src/mcp/server.ts` creates MCP server via `@modelcontextprotocol/sdk`
- [ ] Mounted on Hono app at `/mcp` path
- [ ] Streamable HTTP transport (SSE) per MCP 2025-03-26 spec
- [ ] Server info: name, version
- [ ] Unit test: MCP server initializes without error
- [ ] Typecheck passes

#### US-078: MCP tool — sandbox_create
**Description:** As an AI agent, I want to create a sandbox via MCP.

**Acceptance Criteria:**
- [ ] Tool name: `sandbox_create`, description: "Create isolated bash sandbox" (under 80 chars)
- [ ] Params: `{}` (none in V1)
- [ ] Returns: `{ id: string }`
- [ ] Typecheck passes

> Future extension (see US-080a): params will include `python?: boolean` and `javascript?: boolean` for runtime opt-in.

#### US-079: MCP tool — sandbox_delete
**Description:** As an AI agent, I want to delete a sandbox via MCP.

**Acceptance Criteria:**
- [ ] Tool name: `sandbox_delete`, description: "Delete sandbox and all files"
- [ ] Params: `{ id: string }`
- [ ] Returns: `{ ok: true }`
- [ ] Typecheck passes

#### US-080: MCP tool — bash_exec
**Description:** As an AI agent, I want to execute bash in a sandbox via MCP. This is the primary tool for all file and directory operations — use shell commands (cat, echo, mkdir, rm, mv, cp, ls, find, sed, awk, etc.) instead of dedicated file/dir tools.

**Acceptance Criteria:**
- [ ] Tool name: `bash_exec`
- [ ] Tool description (multi-line, shown to agent):
  ```
  Execute a bash script in a sandbox. Returns stdout, stderr, and exitCode.

  Supported: cat, echo, ls, find, mkdir, rm, mv, cp, touch, chmod, stat, grep, sed, awk,
  sort, wc, head, tail, cut, tr, uniq, diff, pipes (|), redirects (>, >>, <),
  environment variables, conditionals (if/else), loops (for/while), functions, arithmetic,
  base64, md5sum, sha256sum, tar, gzip, jq, yq, xan, sqlite3.

  NOT supported: curl/wget (no network), apt/pip/npm (no package managers),
  vi/vim/nano (no interactive), background jobs (&), kill/ps/top (no process control),
  /proc /sys /dev (no special filesystems), ln -s (symlinks off by default),
  gcc/make/rustc (no compilers), interpreters (python, node, ruby), network access of any kind.
  ```
- [ ] Params: `{ id: string, script: string, timeout?: number }`
- [ ] Returns: `{ stdout: string, stderr: string, exitCode: number }`
- [ ] Buffered (not streaming) — full result in one response
- [ ] Typecheck passes

> Future extension (see US-080a): when runtime opt-in ships, description will add a "Optional runtimes (only if sandbox was created with python:true or javascript:true)" section naming `python3`/`python` and `js-exec`/`node`, and `python3`-containing scripts will route through a process-wide semaphore.

#### US-086: MCP tool — fs_ingest
**Description:** As an AI agent, I want to upload multiple files into a sandbox in one call. This is the preferred way to seed a sandbox with project files before running bash commands.

**Acceptance Criteria:**
- [ ] Tool name: `fs_ingest`, description: "Upload files into sandbox (use before bash_exec)"
- [ ] Params: `{ id: string, basePath?: string, files: { [path]: string } }` (content as plain text, not base64 — simpler for agents)
- [ ] `basePath` defaults to `/home/user`; relative paths in `files` are joined to it
- [ ] Creates all parent directories automatically
- [ ] Returns: `{ ok: true, count: number }`
- [ ] Typecheck passes

#### US-087: MCP tool — fs_export
**Description:** As an AI agent, I want to download all modified files from a sandbox in one call. This is the preferred way to retrieve results after running bash commands.

**Acceptance Criteria:**
- [ ] Tool name: `fs_export`, description: "Download files from sandbox as JSON map"
- [ ] Params: `{ id: string, path?: string }` (`path` defaults to `/home/user`)
- [ ] Returns: `{ files: { [path]: string } }` (utf8 text; binary files as base64 with `"__encoding":"base64"` marker in the map)
- [ ] Typecheck passes

#### US-080a: Runtime opt-in and Python semaphore *(future roadmap — not V1)*
**Description:** As a developer, I want Python/JS runtimes to be opt-in per sandbox and Python executions globally throttled to prevent OOM under concurrent load.

**Why this is deferred:** Each `python3` invocation spawns a fresh ~80MB CPython WASM worker (EXIT_RUNTIME, not reusable). `just-bash` keeps a per-`Bash` queue so calls within one sandbox already serialize, but nothing caps Python usage *across* sandboxes. With 100 concurrent sandboxes each running Python we'd peak at ~8GB RAM — well past the 2Gi ACA limit. V1 ships without Python/JS to avoid this risk. When revisiting, follow the guide below exactly.

**Background (must-read before implementing):**
- `just-bash@2.14.2`'s `python3` command (`node_modules/just-bash/dist/commands/python3/`) spawns `worker_threads` Workers with `EXIT_RUNTIME` — each invocation loads `vendor/cpython-emscripten/python.wasm` (5.7MB) + `python313.zip` stdlib (4.1MB) fresh. CPython WASM has no `import js`, no `os.system`, and stdlib only (no pip). See `node_modules/just-bash/dist/commands/python3/worker.d.ts` for the security model.
- `just-bash`'s `js-exec` command uses QuickJS WASM with a 64MB per-execution memory cap (lighter than Python — no global throttle needed for V1 of this feature).
- `just-bash` enables Python / JS via `new Bash({ fs, python: true, javascript: true })`. Without those flags the commands don't exist.
- The per-`Bash` queue inside just-bash is keyed by a WeakMap on the command object — it is per-sandbox, not global. So the global semaphore must live at the SessionManager level in our code, not inside just-bash.

**Acceptance Criteria:**
- [ ] Add `RuntimeOptions` interface to `src/api/session-manager.ts`: `{ readonly python: boolean; readonly javascript: boolean }`
- [ ] Extend `Session` with `readonly runtimeOptions: RuntimeOptions`
- [ ] Extend `SessionManagerOptions` with `readonly maxConcurrentPython?: number` (default: `MAX_CONCURRENT_PYTHON` env var or 5)
- [ ] `getOrCreate(sandboxId, runtimeOptions?)` — defaults to `{ python: false, javascript: false }`. On cache miss, passes both flags into `new Bash({ fs, python: runtimeOptions.python || undefined, javascript: runtimeOptions.javascript || undefined })`. Must use `|| undefined` so `false` becomes `undefined` (just-bash treats both as off, but the types differ)
- [ ] `withSession(sandboxId, fn, runtimeOptions?)` forwards `runtimeOptions` to `getOrCreate`. Note that runtimeOptions are applied only on **cache miss** — the first caller "wins" the runtime flags. Document this clearly in the JSDoc so future callers do not expect to toggle runtimes on a warm session
- [ ] Add private semaphore state to `SessionManager`:
  - `pythonInFlight: number` (counter)
  - `pythonWaiters: Array<() => void>` (FIFO queue of resolvers)
  - `acquirePythonSlot(): Promise<void>` — if `pythonInFlight < maxConcurrentPython`, increments and resolves immediately; otherwise pushes a resolver and returns a pending promise
  - `releasePythonSlot(): void` — if queue non-empty, shifts + calls the next resolver (handing over the slot without decrementing); else decrements the counter. **This transfer-on-release pattern avoids a counter race.**
- [ ] Add public `execWithRuntimeThrottle(session, script, opts?): Promise<BashExecResult>`:
  - `const usesPython = session.runtimeOptions.python && /\bpython3?\b/.test(script)`
  - Non-Python path: `return session.bash.exec(script, opts)` (no semaphore)
  - Python path: `await acquirePythonSlot()`, then `try { return await session.bash.exec(script, opts) } finally { releasePythonSlot() }`
  - The regex must use word boundaries (`\b`) to avoid false positives like `mypython`
- [ ] Migrate **all** direct `session.bash.exec(...)` call sites to `sessionManager.execWithRuntimeThrottle(session, ...)`:
  - `src/api/routes/exec.ts` — both exec-sync and SSE streaming paths
  - `src/api/routes/ingest.ts` — tar extract (ingest) and tar pack (export) paths, plus the `rm /tmp/_export.tar.gz` cleanup
  - `src/api/mcp/tools.ts` — the `bash_exec` tool handler
- [ ] `POST /v1/sandboxes` (HTTP) accepts `python?: boolean, javascript?: boolean` body fields and forwards via `withSession(..., { python, javascript })`. 201 response includes the resolved flags
- [ ] `sandbox_create` MCP tool accepts the same two boolean params and calls `getOrCreate(id, { python, javascript })`
- [ ] `bash_exec` MCP tool description updated to add an "Optional runtimes" section listing `python3`/`python` (CPython WASM, stdlib only, no pip) and `js-exec`/`node` (QuickJS WASM, TypeScript supported, no npm), gated on "only if sandbox was created with python:true or javascript:true"
- [ ] Document `MAX_CONCURRENT_PYTHON` in the env var table in `CLAUDE.md` and any deployment docs
- [ ] Unit test (`src/api/__tests__/session-manager.test.ts`):
  - Semaphore allows up to N concurrent Python executions, queues the (N+1)th until a slot frees
  - Non-Python script bypasses semaphore entirely (`pythonInFlight` never increments)
  - Slot is released even when `bash.exec` throws — use `try/finally` to verify a failing exec still decrements
  - Regex does not match `mypython_script` (word boundary check)
  - Warm session ignores subsequent `runtimeOptions` (cache hit path)

**Testing gotcha:** The in-memory `InMemoryFs` backend doesn't care about runtime flags, but creating `new Bash({ python: true })` in tests actually loads the Python WASM on first `python3` call and adds ~500ms–2s to the test. Prefer mocking `bash.exec` or only invoking Python in a single dedicated integration test.

#### US-087a: MCP tools — per-sandbox ownership enforcement
**Description:** As a developer, I want MCP tools to enforce per-sandbox ownership so that an authenticated user can only operate on sandboxes they created, matching the authorization model of the HTTP API routes.

**Acceptance Criteria:**
- [ ] `handleMcpRequest` in `src/api/mcp/server.ts` extracts the authenticated caller identity (e.g., JWT `sub` claim) from the HTTP request and makes it available to tool handlers (via MCP session context, closure, or similar mechanism)
- [ ] `sandbox_create` sets `session.owner` to the caller identity (matching `POST /v1/sandboxes` behavior in `routes/sandboxes.ts`)
- [ ] `sandbox_delete`, `bash_exec`, `fs_ingest`, `fs_export` verify that the caller identity matches `session.owner` before proceeding; if `session.owner` is set and does not match, return `{ ok: false, error: "forbidden" }` (or equivalent error content)
- [ ] When `session.owner` is empty string (legacy/migration case), ownership check is skipped (matches HTTP route `checkOwnership` behavior)
- [ ] Unit test: create sandbox as user A, attempt `bash_exec` as user B — returns forbidden error
- [ ] Unit test: create sandbox as user A, `bash_exec` as user A — succeeds
- [ ] Unit test: `sandbox_create` sets owner on the session
- [ ] Typecheck passes
- [ ] Tests pass

---

### Epic 20: Containerization & Deployment

#### US-088: Dockerfile (multi-stage build)
**Description:** As a DevOps engineer, I want a Dockerfile that produces a small production image.

**Acceptance Criteria:**
- [ ] Builder stage: `node:22-bookworm`, pnpm install, pnpm build (just-bash + api)
- [ ] Runtime stage: `node:22-slim`, copies only `dist/`, `node_modules/`, `package.json`
- [ ] Non-root user (`app:app`)
- [ ] `EXPOSE 8080`
- [ ] `HEALTHCHECK` using `/healthz`
- [ ] Image size under 300MB
- [ ] `docker build .` succeeds
- [ ] Typecheck passes (build must succeed)

#### US-089: .dockerignore
**Description:** As a DevOps engineer, I want unnecessary files excluded from Docker build context.

**Acceptance Criteria:**
- [ ] Excludes: `node_modules`, `.git`, `src`, `*.test.ts`, `*.md`, `vendor`, `.env*`
- [ ] Build context under 5MB (excluding vendor/wasm)

#### US-090: Azure Container Apps deployment YAML
**Description:** As a DevOps engineer, I want ACA config with probes, scaling, secrets, and optional FileShare mount.

**Acceptance Criteria:**
- [ ] `aca.yaml` with ingress (external, port 8080, sticky sessions)
- [ ] Secrets for `DATABASE_URL`, `DATABASE_DIRECT_URL`, auth config
- [ ] Liveness probe: `GET /healthz` every 15s
- [ ] Readiness probe: `GET /readyz` every 10s
- [ ] Startup probe: `GET /readyz` with 30 retries
- [ ] Scale: min 1, max 10, rule: 50 concurrent requests
- [ ] Optional volume mount for Azure FileShare (commented out with instructions)
- [ ] Resource limits: 1 CPU, 2Gi memory

#### US-091: Startup migration runner
**Description:** As a developer, I want migrations to run automatically when the container starts.

**Acceptance Criteria:**
- [ ] `api/src/server.ts` runs Drizzle migrations before `app.listen()`
- [ ] Uses `DATABASE_DIRECT_URL` (not pooler) for migrations
- [ ] Logs migration status
- [ ] Fails fast if migration fails (process exits with code 1)
- [ ] Unit test: mock migration, verify called before listen
- [ ] Typecheck passes

---

### Epic 21: Database Migrations

#### US-092: Drizzle schema definition
**Description:** As a developer, I want the Drizzle ORM schema matching our table design.

**Acceptance Criteria:**
- [ ] `src/fs/sql-fs/schema.ts` defines: `blobs`, `inodes`, `dirents`, `sandboxes` tables
- [ ] Indexes: `inodes(sandbox_id)`, `dirents(sandbox_id, inode_id)`, `dirents(sandbox_id, parent_inode_id)`
- [ ] Foreign keys with `ON DELETE CASCADE` where appropriate
- [ ] Typecheck passes

#### US-093: Postgres migration — tables
**Description:** As a developer, I want auto-generated Drizzle migration for Postgres table creation.

**Acceptance Criteria:**
- [ ] `pnpm db:generate` produces migration SQL
- [ ] Migration creates all 4 tables with correct types (BIGSERIAL, BYTEA, TIMESTAMPTZ, etc.)
- [ ] Migration is idempotent (uses `IF NOT EXISTS`)
- [ ] `pnpm db:migrate` runs successfully against empty Postgres database

#### US-094: Postgres migration — RLS, extensions, stored procedures
**Description:** As a developer, I want a hand-written migration for Phase 1 Postgres sandbox isolation and Postgres-specific features.

**Acceptance Criteria:**
- [ ] `CREATE EXTENSION IF NOT EXISTS pgcrypto`
- [ ] RLS enabled on `inodes` and `dirents`
- [ ] RLS is forced on `inodes` and `dirents`
- [ ] RLS policies filter by `current_setting('app.sandbox_id', true)` and match the actual sandbox ID column type
- [ ] `fs_resolve` function created with `CREATE OR REPLACE`
- [ ] `ALTER TABLE blobs ALTER COLUMN data SET STORAGE EXTERNAL`
- [ ] Migration is idempotent
- [ ] Integration test: sandbox A cannot read or mutate sandbox B rows when context is set to sandbox A

#### US-095: MySQL migration
**Description:** As a developer, I want equivalent migration for MySQL 8+.

**Acceptance Criteria:**
- [ ] Creates tables with MySQL types (AUTO_INCREMENT, LONGBLOB, DATETIME(6))
- [ ] Creates `fs_resolve` stored procedure
- [ ] No RLS (MySQL doesn't support it)
- [ ] Migration runs successfully against empty MySQL 8 database

#### US-096: Azure SQL migration
**Description:** As a developer, I want equivalent migration for Azure SQL.

**Acceptance Criteria:**
- [ ] Creates tables with T-SQL types (IDENTITY, VARBINARY(MAX), DATETIMEOFFSET)
- [ ] Creates `fs_resolve` stored procedure in T-SQL
- [ ] Creates RLS security policy using SESSION_CONTEXT
- [ ] Migration runs successfully against empty Azure SQL database

---

### Epic 22: Blob Garbage Collection

#### US-097: GC via dialect method
**Description:** As a developer, I want each dialect to support orphan blob cleanup.

**Acceptance Criteria:**
- [ ] `gcOrphanBlobs(tx)` deletes blobs not referenced by any inode
- [ ] Returns count of deleted blobs
- [ ] Unit test per dialect: create referenced + orphan blobs, GC, verify only orphans deleted

#### US-098: GC admin endpoint
**Description:** As an operator, I want an HTTP endpoint to trigger garbage collection.

**Acceptance Criteria:**
- [ ] `POST /v1/admin/gc` (admin-only auth)
- [ ] Returns `{ deleted: number }`
- [ ] Unit test: trigger GC via endpoint, verify response

#### US-099: GC CLI command
**Description:** As an operator, I want to trigger GC from the command line.

**Acceptance Criteria:**
- [ ] `pnpm db:gc` script connects to DB and runs gcOrphanBlobs
- [ ] Prints count of deleted blobs
- [ ] Exits 0 on success

---

### Epic 23: Integration Testing

#### US-100: SqlFs integration test against Postgres
**Description:** As a developer, I want end-to-end tests proving SqlFs works with real Postgres.

**Acceptance Criteria:**
- [ ] Test suite creates a sandbox, writes files, reads them, moves them, deletes them
- [ ] Verifies pathCache stays in sync after every operation
- [ ] Verifies contentCache hits/misses
- [ ] Skippable in CI if `DATABASE_URL` not set
- [ ] Typecheck passes

#### US-101: SqlFs integration test against MySQL
**Description:** As a developer, I want the same integration tests running against MySQL.

**Acceptance Criteria:**
- [ ] Same test scenarios as US-100 but using MySqlDialect
- [ ] Skippable if `MYSQL_URL` not set

#### US-102: SqlFs integration test against Azure SQL
**Description:** As a developer, I want the same integration tests running against Azure SQL.

**Acceptance Criteria:**
- [ ] Same test scenarios as US-100 but using AzureSqlDialect
- [ ] Skippable if `AZURE_SQL_URL` not set

#### US-103: Run just-bash comparison tests with SqlFs
**Description:** As a developer, I want to verify that existing bash behavior is preserved when using SqlFs instead of InMemoryFs.

**Acceptance Criteria:**
- [ ] Modify comparison test harness to optionally use SqlFs (via env var)
- [ ] Run `pnpm test:comparison` with `FS_BACKEND=postgres` and `DATABASE_URL` set
- [ ] All existing comparison tests pass
- [ ] Skippable if DB not available

#### US-104: HTTP API end-to-end test
**Description:** As a developer, I want integration tests covering the full HTTP request lifecycle.

**Acceptance Criteria:**
- [ ] Test creates sandbox via POST, writes files, executes bash, reads output, exports tar.gz, deletes sandbox
- [ ] Uses supertest or Hono test client
- [ ] Runs against in-memory backend (no real DB needed)
- [ ] Typecheck passes

#### US-105: MCP tools end-to-end test
**Description:** As a developer, I want integration tests covering MCP tool calls.

**Acceptance Criteria:**
- [ ] Test calls sandbox_create, bash_exec, file_read, file_write, sandbox_delete via MCP client
- [ ] Uses in-memory backend
- [ ] Verifies tool responses match expected shapes
- [ ] Typecheck passes

---

## Functional Requirements

- FR-1: `SqlFs` must implement all 20+ methods of `IFileSystem` as defined in `src/fs/interface.ts`
- FR-2: `SqlDialect` implementations must support Postgres 14+, MySQL 8+, and Azure SQL
- FR-3: Path resolution must support symlinks with a 40-hop depth limit matching `MAX_SYMLINK_DEPTH` in `src/fs/path-utils.ts`
- FR-4: Symlinks must be default-deny (`allowSymlinks: false`), matching just-bash security posture
- FR-5: `pathCache` must be loaded at session start in a single query and kept in sync on every write/delete/move operation
- FR-6: `contentCache` must be an LRU with configurable max byte budget (default 50MB), keyed by inode ID
- FR-7: `getAllPaths()` (sync method) must be served from pathCache without any database call
- FR-8: `stat()`, `lstat()`, `exists()`, `readdir()` must be served from pathCache without any database call when cached
- FR-9: `mv()` of a subtree must be O(1) at the SQL level (single dirent row update, not O(n) path string updates)
- FR-10: `writeFile()` must deduplicate content via content-addressable sha256 keys in the blobs table
- FR-11: All SQL errors must be translated to standard FS error codes (ENOENT, EEXIST, EISDIR, ENOTDIR, ENOTEMPTY, ELOOP, EPERM, EACCES)
- FR-12: All error messages must be sanitized to prevent leaking database connection strings or host filesystem paths
- FR-13: Sandbox isolation via RLS (Postgres, Azure SQL) or application-level WHERE clauses (MySQL); sandbox A must never see sandbox B's files
- FR-14: RLS context must use `SET LOCAL` (Postgres) / session variable (MySQL) / `SESSION_CONTEXT` (Azure SQL) scoped to the transaction, compatible with transaction-mode connection pooling
- FR-15: HTTP API must validate all input via zod schemas
- FR-16: HTTP API must authenticate requests via Bearer token
- FR-17: HTTP exec endpoint must support SSE streaming for stdout/stderr
- FR-18: HTTP exec must enforce configurable timeout (default 30s, max 300s) and cancel via AbortController
- FR-19: MCP tool set is intentionally minimal (5 tools): `sandbox_create`, `sandbox_delete`, `bash_exec`, `fs_ingest`, `fs_export`. File/dir operations (cat, ls, mkdir, rm, mv, cp, etc.) are performed via `bash_exec` shell commands. Tool names must be under 20 chars. `bash_exec` description must enumerate supported commands and explicitly list unsupported features (networking, package managers, interactive commands, /proc//sys//dev, symlinks, compilation, interpreter runtimes) so agents don't attempt them.
- FR-20: MCP server must use streamable HTTP transport per MCP 2025-03-26 specification
- FR-21: Ingest endpoint must accept tar.gz archives and extract using just-bash's built-in tar command
- FR-22: Export endpoint must produce tar.gz archives using just-bash's built-in tar command
- FR-23: Factory function must select backend from environment variables (`FS_BACKEND`, `DATABASE_URL`, `FS_MOUNT_PATH`)
- FR-24: Container image must be under 300MB and start in under 10 seconds
- FR-25: Migrations must run automatically on container startup before the HTTP server binds

## Non-Goals (Out of Scope for V1)

- No real-time file watching or WebSocket-based file change notifications
- No auto-expiry or idle timeout for sandboxes (manual delete only in V1)
- No quota enforcement (max files, max storage per sandbox)
- No usage metering or billing hooks
- No multi-region replication or read replicas
- No interactive shell over WebSocket (exec is request/response or SSE, not a persistent terminal)
- No Neon branching for per-sandbox isolation (RLS only in V1)
- No S3/R2 offload for large files
- No schema-per-tenant or database-per-tenant isolation models

### Deferred to Future Roadmap (documented but not in V1)

- **MySQL backend** (Epic 9, US-043 through US-046) — stories remain accurate; enable by implementing `src/fs/sql-fs/dialects/mysql.ts` against the `SqlDialect` interface
- **Azure SQL backend** (Epic 10, US-047 through US-050) — stories remain accurate; enable by implementing `src/fs/sql-fs/dialects/azure-sql.ts`
- **Azure FileShare backend** (Epic 11, US-051, US-052) — stories remain accurate; `createSandboxFs` factory already has a stub branch to return `ReadWriteFs({ root: mountPath/sandboxId })`. See `COMPARISON.md` for the FileShare-vs-Postgres tradeoffs that led to deferring this
- **Python/JavaScript WASM runtime opt-in + global Python semaphore** (US-080a) — stories remain accurate with full implementation guide; enable by following the acceptance criteria on US-080a verbatim

## Technical Considerations

### Architecture

```
HTTP/MCP Client (agent or developer)
       |
       v
+----------------------------------+
| Azure Container App              |
|                                  |
|  Hono HTTP server + MCP server   |
|       |                          |
|  Session Manager                 |
|    +- Bash instance per sandbox  |
|         +- IFileSystem           |
|              |                   |
|         createSandboxFs()        |
|         +----+-----+            |
|         v    v     v            |
|      SqlFs  SqlFs  ReadWriteFs  |
|      (PG)  (MySQL) (FileShare)  |
+--------+----+--------+----------+
         |    |        |
         v    v        v
      Postgres MySQL  Azure FileShare
      AzureSQL        (SMB mount)
```

### Key Dependencies (new)

- `hono` — HTTP framework
- `postgres` — Postgres driver (for Postgres dialect)
- `mysql2` — MySQL driver (for MySQL dialect)
- `mssql` — Azure SQL driver (for Azure SQL dialect)
- `drizzle-orm` + `drizzle-kit` — schema and migrations
- `lru-cache` — content LRU cache
- `@modelcontextprotocol/sdk` — MCP server SDK
- `zod` — request validation

### Caching Strategy

- **pathCache** (Map): loaded once at session init, updated synchronously on every write. Budgeted at 50MB per session by default; if a full path tree exceeds budget, the session should not keep that warm pathCache resident after the active request finishes. Serves stat/exists/readdir/getAllPaths with zero DB calls while resident.
- **contentCache** (LRU): fills lazily on first read, capped at 50MB per session, evicted LRU when full. Invalidated on write/delete to the same inode.
- Cache is per-session, per-process, ephemeral. Postgres/MySQL/Azure SQL is the durable source of truth. Process restart reloads cache from DB.

### File Layout (new files)

```
src/fs/sql-fs/
  index.ts                  <- createSandboxFs factory + destroySandbox
  sql-fs.ts                 <- SqlFs class (IFileSystem, caching, error translation)
  types.ts                  <- SqlDialect interface, InodeRow, DirentRow, CacheEntry
  schema.ts                 <- Drizzle schema (shared across dialects)
  errors.ts                 <- FS error constructors + sanitization
  dialects/
    postgres.ts             <- PostgresDialect
    mysql.ts                <- MySqlDialect
    azure-sql.ts            <- AzureSqlDialect
  migrations/
    0000_create_tables.sql
    0001_rls_and_procs.sql
api/
  package.json
  drizzle.config.ts
  src/
    server.ts               <- Hono app entry + migration runner
    routes/
      sandboxes.ts          <- CRUD endpoints
      files.ts              <- File operation endpoints
      exec.ts               <- Bash execution endpoints
      ingest.ts             <- Ingest/export endpoints
    session-manager.ts      <- Warm Bash instance pool
    auth.ts                 <- Bearer token middleware
    validation.ts           <- Zod validation middleware
    errors.ts               <- HTTP error responses
    mcp/
      server.ts             <- MCP server with tool definitions
      tools.ts              <- Tool schemas and handlers
Dockerfile
.dockerignore
aca.yaml                    <- Azure Container Apps deployment config
```

### Security Considerations

- All SQL errors sanitized before surfacing (no connection strings, host paths, or internal table names in error messages)
- Symlinks default-deny, matching just-bash security posture
- RLS enforces sandbox isolation at database level (Postgres, Azure SQL); app-level WHERE clause for MySQL
- Bearer token auth on all API endpoints
- Exec timeout prevents runaway scripts
- Content-addressable blobs prevent duplicate storage but require GC to avoid orphan buildup
- No `--allow-write` on real host filesystem — all writes go to SQL or FileShare sandbox directory

## Success Metrics

- All existing just-bash comparison tests pass when running against SqlFs (Postgres dialect) instead of InMemoryFs
- `stat()` / `readdir()` / `exists()` return in <1ms after session warmup (cache hit)
- `readFile()` returns in <1ms on cache hit, <5ms on cache miss (same-region DB)
- `writeFile()` completes in <10ms (same-region DB)
- `mv()` of a 10,000-file subtree completes in <5ms (single row update)
- Sandbox creation (POST /v1/sandboxes) completes in <200ms including initial directory setup
- Ingest of a 5MB tar.gz (typical small project) completes in <2 seconds
- Container image under 300MB
- Container cold start under 10 seconds

## Open Questions

- Should we add a `PATCH /v1/sandboxes/:id/files/*path` for partial file updates (append), or is `PUT` (full replace) sufficient for V1?
- Should MCP tools support streaming exec output via MCP notifications, or is buffered response acceptable for V1?
- For MySQL (no RLS): is application-level WHERE sufficient, or should we consider MySQL 8 views with `DEFINER` for pseudo-RLS?
- Should blob GC run on a schedule (pg_cron) or only on-demand via admin endpoint?
- What authentication provider should the Bearer token validate against (JWT with JWKS, API key table, or pluggable)?
- Should we support sandbox cloning (create new sandbox as copy of existing)?
