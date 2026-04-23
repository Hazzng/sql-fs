# Storage Backend Comparison: FileShare vs Postgres vs Hybrid

Deciding how to persist sandbox filesystem data. Three viable options:

1. **FileShare-only** — Use a mounted network filesystem (Azure Files / AWS EFS / GCP Filestore) with `ReadWriteFs`
2. **Postgres-only** — Store everything (metadata + content) in Postgres via `SqlFs`
3. **Hybrid** — Metadata in Postgres, content (blobs) on FileShare — keyed by sha256

---

## Quick Comparison Matrix

| Dimension | FileShare | Postgres | Hybrid |
|---|---|---|---|
| **New code required** | ~0 lines (ReadWriteFs exists) | ~1000 lines (SqlFs + 3 dialects) | ~1000 lines + ~50 lines blob adapter |
| **Per-file read latency** | ~1ms (NFS/SMB direct) | ~2-5ms (SQL query + network) | ~1-2ms (cache hit) / ~3ms (miss) |
| **Per-file write latency** | ~1-2ms | ~3-10ms | ~2-3ms |
| **Large files (>10MB)** | Native streaming, no limit | BYTEA 1GB limit, TOAST overhead | Native streaming via FS |
| **Content dedup** | None (N copies = N × storage) | Automatic via sha256 CAS | Automatic via sha256 filename |
| **Atomic rename (subtree mv)** | O(1) filesystem rename | O(1) single UPDATE | O(1) single UPDATE |
| **Multi-region reads** | Region-locked (single mount) | Multi-region read replicas possible | Metadata multi-region, blobs region-locked |
| **Sandbox isolation** | Directory permissions | RLS (DB-level, bulletproof) | RLS + blob path scoped by sandbox_id |
| **Metadata queries** | Impossible without `find` | Instant SQL | Instant SQL |
| **Cold start** | None (mounted at container start) | None (connection pool) | None |
| **Cost per GB (Azure)** | ~$0.06/GB/mo (hot) | ~$0.15-0.25/GB/mo | ~$0.06 blobs + ~$0.20 metadata (tiny) |
| **Backup/restore** | Snapshot mount | `pg_dump` | Snapshot mount + `pg_dump` |
| **Cleanup on sandbox delete** | `rm -rf` (slow on deep trees over NFS) | `DELETE CASCADE` (instant) | `DELETE CASCADE` + async blob GC |

---

## Option 1: FileShare-Only

```
┌──────────────────┐
│ Container        │
│                  │
│   ReadWriteFs    │
│        │         │
└────────┼─────────┘
         │ NFS/SMB mount
         ▼
   /mnt/sandboxes/
     ├── sandbox-abc/
     │     └── home/user/app.js
     ├── sandbox-xyz/
     │     └── home/user/main.py
     └── ...
```

### Pros
- **Zero new code.** `ReadWriteFs` already exists in just-bash, just point it at a mount path.
- **Lowest latency for raw reads** — ~1ms NFS round-trip vs ~2-5ms SQL.
- **No size limits.** Stream multi-GB files natively.
- **Familiar ops.** SREs already know how to manage NFS/SMB shares, snapshots, backups.
- **Standard tools work.** `tar`, `rsync`, `find`, Azure Portal Storage Explorer — all usable for debugging.

### Cons
- **No dedup.** 1000 sandboxes with same 100MB `node_modules` = 100GB of redundant data.
- **No metadata queries.** Cannot answer "how big is sandbox X?" or "which sandboxes have file Y?" without scanning directories.
- **Region-locked.** A FileShare in East US cannot be read from a West US container. Multi-region deployments need replication (Azure File Sync, EFS replication).
- **Directory-level isolation only.** One misconfigured mount or path traversal bug exposes all sandboxes. No DB-level RLS defense.
- **Slow recursive delete.** `rm -rf sandbox-abc/` on an NFS share with 100k small files can take minutes (network round-trips per file).
- **No atomic multi-file operations.** Can't atomically rename file A AND update file B. Transactions don't exist on a filesystem.
- **Locking is unreliable over NFS.** `flock`, `fcntl` semantics differ across NFS versions and providers.

### When to pick this
- You have few sandboxes (< 100) with large files.
- You don't need cross-sandbox dedup.
- You want the simplest possible implementation.
- You don't need structured metadata queries.

---

## Option 2: Postgres-Only

```
┌──────────────────┐
│ Container        │
│                  │
│      SqlFs       │
│   ┌─────────┐    │
│   │ caches  │    │
│   └────┬────┘    │
└────────┼─────────┘
         │ SQL over network
         ▼
   Postgres
     ├── sandboxes
     ├── inodes
     ├── dirents
     └── blobs  ← file content as BYTEA
```

### Pros
- **Content dedup.** Same bytes across 1000 sandboxes stored once via `sha256` CAS.
- **RLS sandbox isolation.** Database-level enforcement, immune to application bugs.
- **Atomic operations.** Rename a subtree of 10k files = one `UPDATE` inside a transaction.
- **Structured metadata queries.** "Which sandboxes are over 1GB?" → `SELECT sandbox_id, SUM(size) FROM inodes GROUP BY sandbox_id HAVING SUM(size) > 1e9`.
- **Easy cleanup.** `DELETE FROM sandboxes WHERE id = X` → cascades to inodes, dirents. Instant.
- **Multi-region reads.** Postgres read replicas or Neon read-only endpoints.
- **Transactional ingest/export.** Partial failure during bulk upload? Rollback, clean state.

### Cons
- **Higher per-op latency.** ~2-5ms vs ~1ms for FS — acceptable for agents (cache hides most of it) but noticeable at scale.
- **Large file overhead.** BYTEA is capped at 1GB and uses TOAST, which adds storage overhead for files > ~2KB. For files > 100MB, BYTEA becomes a bottleneck.
- **DB storage is expensive.** ~$0.15-0.25/GB/mo for managed Postgres vs ~$0.06/GB/mo for Azure Files.
- **WAL bloat.** Every file write generates WAL entries. Heavy write workloads (ingest of a 1GB project) stress replication and backup.
- **Complex implementation.** ~1000 lines of SqlFs + 3 dialects + stored procs + migrations.

### When to pick this
- Many small sandboxes (many files < 10MB each).
- Cross-sandbox dedup is valuable (agent boilerplate, node_modules, templates).
- You need structured queries over sandbox metadata.
- Strong sandbox isolation is a hard requirement (multi-tenant SaaS).
- Sandboxes are frequently created/destroyed.

---

## Option 3: Hybrid (Recommended for Scale)

Split the concerns: **Postgres owns metadata, FileShare owns blobs.** Same sha256 content-addressable model, but the actual bytes live on disk.

```
┌──────────────────┐
│ Container        │
│                  │
│  SqlFs (hybrid)  │
│   ┌───────────┐  │
│   │ pathCache │  │
│   │ contentLRU│  │
│   └─────┬─────┘  │
└─────────┼────────┘
          │
     ┌────┴─────────────┐
     │                  │
     ▼                  ▼
 Postgres           /mnt/blobs/     (NFS/SMB mount)
  ├── sandboxes      ├── ab/cd/abcd1234…  ← sha256 "abcd1234..."
  ├── inodes         ├── ef/01/ef012345…  ← 12 KB file
  └── dirents        └── ...
```

### How it works

**Schema change:** the `blobs` table disappears, replaced by `content_sha256 BYTEA` staying on the inode.

```sql
CREATE TABLE inodes (
  id              BIGSERIAL PRIMARY KEY,
  sandbox_id      UUID NOT NULL,
  kind            SMALLINT NOT NULL,
  mode            INT NOT NULL,
  size            BIGINT NOT NULL,
  mtime           TIMESTAMPTZ NOT NULL,
  nlink           INT NOT NULL DEFAULT 1,
  content_sha256  BYTEA,          -- points to FileShare path, not a blobs row
  symlink_target  TEXT
);
-- No more blobs table.
```

**Blob storage convention:** sha256 is hex-encoded and sharded by first 2 bytes to avoid huge single-directory problem:

```
/mnt/blobs/ab/cd/abcd1234deadbeef...   ← file with sha256 = 0xabcd1234deadbeef...
/mnt/blobs/ef/01/ef012345cafebabe...
```

**Read path:**
```typescript
async readFile(path: string): Promise<Uint8Array> {
  const entry = this.pathCache.get(path);              // 0ms
  if (!entry) throw createEnoent(path);

  const cached = this.contentCache.get(entry.inodeId); // 0ms if hit
  if (cached) return cached;

  const hex = entry.contentSha256.toString('hex');
  const blobPath = `/mnt/blobs/${hex.slice(0,2)}/${hex.slice(2,4)}/${hex}`;
  const bytes = await fs.promises.readFile(blobPath);  // ~1ms NFS
  this.contentCache.set(entry.inodeId, bytes);
  return bytes;
}
```

**Write path:**
```typescript
async writeFile(path: string, content: Uint8Array): Promise<void> {
  const sha256 = crypto.createHash('sha256').update(content).digest();
  const hex = sha256.toString('hex');
  const blobPath = `/mnt/blobs/${hex.slice(0,2)}/${hex.slice(2,4)}/${hex}`;

  // Write blob to FileShare (idempotent — rename for atomicity)
  if (!existsSync(blobPath)) {
    await fs.promises.mkdir(dirname(blobPath), { recursive: true });
    const tmp = `${blobPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(tmp, content);
    await fs.promises.rename(tmp, blobPath);     // atomic on POSIX/NFSv4
  }

  // Update Postgres metadata (inode + dirent)
  await this.dialect.transaction(async (tx) => {
    const inodeId = await this.dialect.createInode(tx, {
      kind: 1, mode: 0o644, size: content.length, contentSha256: sha256,
    });
    await this.dialect.upsertDirent(tx, parentId, basename, inodeId);
  });

  // Update caches
  this.pathCache.set(path, { inodeId, kind: 1, mode: 0o644, size: content.length, mtime: new Date(), contentSha256: sha256 });
  this.contentCache.set(inodeId, content);
}
```

### Pros — the best of both worlds

- **Content dedup preserved.** Same sha256 = one file on disk, regardless of how many inodes reference it.
- **Fast content reads.** ~1ms NFS vs ~2-5ms BYTEA fetch.
- **No BYTEA size/TOAST pain.** Files of any size, native streaming.
- **Cheap storage.** Blobs on FileShare at ~$0.06/GB; Postgres only holds tiny metadata rows (~200 bytes each).
- **Metadata queries retained.** Same SQL queries as Postgres-only option.
- **RLS retained.** Sandbox isolation still DB-enforced. Blobs referenced via opaque sha256 — knowing a hash doesn't tell you which sandbox owns a file.
- **Atomic rename/mv unchanged.** Still O(1) single-row UPDATE on dirents.
- **Lower DB load.** No WAL entries for file content, dramatically reducing replication and backup pressure.

### Cons

- **Two storage systems to operate.** Both Postgres and FileShare must be available. Adds failure modes.
- **Consistency window.** Writing blob to FS then metadata to DB: if container crashes between these two steps, the blob is orphaned (cheap, GC-able) but no inconsistency. If reversed (metadata first, blob second), an inode could reference a missing blob — so **always write blob first, metadata second**.
- **Blob GC required.** Deleting an inode doesn't auto-delete the blob (might be shared). Need a periodic job.
- **Cross-region harder.** Blobs live on one FileShare; multi-region requires FileShare replication (Azure File Sync, EFS cross-region replication, GCP Filestore Backups).
- **Slightly more code.** ~50 lines of blob adapter on top of SqlFs.

### Blob garbage collection

Can't use a simple "delete when ref_count=0" — blobs are shared. Instead, run periodic GC:

```sql
-- Find candidate sha256 values from Postgres
SELECT DISTINCT content_sha256 FROM inodes WHERE content_sha256 IS NOT NULL;
```

Then walk `/mnt/blobs/` and delete any file whose sha256 isn't in that set. Run weekly or triggered when storage exceeds threshold.

Safer two-phase approach:
1. List all blob filenames (sha256 hashes) on FileShare → set A
2. `SELECT DISTINCT content_sha256 FROM inodes` → set B
3. Delete files in `A \ B` (but only files older than, say, 1 hour to avoid races with concurrent writes)

### Migration path

The code already designed for Postgres-only can switch to Hybrid by replacing one method on the dialect:

```typescript
// Before (Postgres-only):
async getBlob(tx, sha256): Promise<Uint8Array> {
  return tx`SELECT data FROM blobs WHERE sha256 = ${sha256}`.then(r => r[0].data);
}

// After (Hybrid):
async getBlob(_tx, sha256): Promise<Uint8Array> {
  const hex = sha256.toString('hex');
  return fs.promises.readFile(`/mnt/blobs/${hex.slice(0,2)}/${hex.slice(2,4)}/${hex}`);
}
```

SqlFs, pathCache, contentCache, API layer — all unchanged.

### When to pick Hybrid

- **At scale** (thousands of sandboxes, TB+ total content).
- Dedup is valuable AND file sizes frequently exceed 10MB.
- You want DB benefits (RLS, metadata queries, atomic ops) without DB storage costs.
- You're OK operating two persistent systems.

---

## Decision Tree

```
Q: Fewer than 100 sandboxes with large files, no dedup needed?
   YES → FileShare-only (simplest, cheapest for this case)

Q: Many sandboxes, small files, dedup valuable, strict isolation?
   YES, but volume < ~500GB total → Postgres-only
   YES, volume > ~500GB total     → Hybrid

Q: Multi-tenant SaaS with strict isolation requirements?
   YES → Postgres-only or Hybrid (both give RLS)
   NO  → FileShare-only is fine

Q: Files routinely > 100MB?
   YES → FileShare-only or Hybrid (avoid BYTEA pain)
   NO  → any option works

Q: Need to query "all sandboxes modified in the last hour"?
   YES → Postgres-only or Hybrid
   NO  → FileShare-only is fine
```

## Recommendation

**Start with Postgres-only** as the PRD already specifies. This is the hardest to build correctly — get that right first. It works well up to hundreds of GB of total content.

When you hit a scale threshold where:
- Postgres storage cost exceeds FileShare cost by >2x, OR
- WAL volume is stressing replication, OR
- Individual files start exceeding 50MB routinely

…then migrate to Hybrid by swapping the `getBlob`/`upsertBlob` methods on the dialect. Everything above the dialect (SqlFs, caches, API, MCP) is unchanged. The migration itself is: copy all rows from `blobs` table to FileShare files, verify, drop the `blobs` table, deploy new dialect code.

**Skip FileShare-only** unless you have a specific reason to avoid a database — it sacrifices too much (dedup, isolation, metadata queries) for a marginal simplicity gain.
