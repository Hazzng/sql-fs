/**
 * SqlDialect interface and shared types for sql-fs-api.
 * US-001: SqlDialect interface definition
 * US-002: Shared types for inode, dirent, cache entry
 */

/** Inode kind: 1=file, 2=directory, 3=symlink */
export type InodeKind = 1 | 2 | 3;

/** Named constants for inode kinds. Prefer these over raw numbers in implementation code. */
export const INODE_KIND = {
	FILE: 1,
	DIRECTORY: 2,
	SYMLINK: 3,
} as const satisfies Record<string, InodeKind>;

/** Storage backend identifiers */
export type StorageBackend = "postgres" | "mysql" | "azure-sql" | "azure-fileshare" | "memory";

/**
 * A database row representing a filesystem inode.
 * Matches the `inodes` table schema.
 */
export interface InodeRow {
	readonly id: bigint;
	readonly sandboxId: string;
	readonly kind: InodeKind;
	readonly mode: number;
	readonly size: number;
	readonly mtime: Date;
	readonly nlink: number;
	readonly contentSha256: Uint8Array | null;
	readonly symlinkTarget: string | null;
}

/**
 * A database row representing a directory entry.
 * Matches the `dirents` table schema.
 */
export interface DirentRow {
	readonly parentInodeId: bigint;
	readonly name: string;
	readonly inodeId: bigint;
}

/**
 * An entry stored in the in-memory path cache, keyed by absolute path.
 * Does not include sandboxId or nlink — those are inode-level concerns.
 */
export interface PathCacheEntry {
	readonly inodeId: bigint;
	readonly kind: InodeKind;
	readonly mode: number;
	readonly size: number;
	readonly mtime: Date;
	readonly contentSha256: Uint8Array | null;
	readonly symlinkTarget: string | null;
}

/** Python runtime selection. null = no Python. */
export type PythonRuntime = "stdlib" | "pyodide" | null;

/** Persisted sandbox metadata needed for session rehydration on cold replicas. */
export interface SandboxMeta {
	readonly owner: string | null;
	readonly name: string | null;
	readonly python_runtime: PythonRuntime;
	readonly javascript: boolean;
	/** When true, js-exec fetch() can reach external HTTP endpoints (60 s timeout). */
	readonly network: boolean;
	/** ISO-8601 timestamp of when the sandbox was originally created (from DB created_at). */
	readonly createdAt?: string;
}

/** A single entry returned by the list-sandboxes query. */
export interface SandboxListEntry {
	readonly id: string;
	readonly name: string | null;
	readonly owner: string | null;
	readonly createdAt: Date;
	readonly python_runtime: PythonRuntime;
	readonly javascript: boolean;
	/** When true, js-exec fetch() can reach external HTTP endpoints (60 s timeout). */
	readonly network: boolean;
}

/** Options for creating a new inode row */
export interface CreateInodeOpts {
	readonly sandboxId: string;
	readonly kind: InodeKind;
	readonly mode: number;
	readonly size: number;
	readonly contentSha256?: Uint8Array | null;
	readonly symlinkTarget?: string | null;
}

/** Fields that can be updated on an existing inode */
export interface UpdateInodeOpts {
	readonly mode?: number;
	readonly size?: number;
	readonly mtime?: Date;
	readonly contentSha256?: Uint8Array | null;
}

/** A single file entry for bulk ingest operations */
export interface BulkIngestFile {
	readonly path: string;
	readonly content: Uint8Array;
	readonly mode: number;
}

/** Options for a transaction. */
export interface TransactionOptions {
	/**
	 * Isolation level for the transaction. Defaults to the connection default
	 * (READ COMMITTED). Use `repeatable read` for the orphan-blob GC so a
	 * concurrent dedup re-adoption surfaces as a serialization failure (retry)
	 * instead of silently deleting a freshly-referenced blob.
	 */
	readonly isolationLevel?: "repeatable read" | "serializable";
}

/**
 * SqlDialect abstracts all database-specific SQL operations so that SqlFs
 * can work with Postgres, MySQL, and Azure SQL without modification.
 *
 * The Tx type parameter is specialised by each dialect with its own
 * transaction handle type (e.g. postgres `Sql` in transaction mode).
 */
export interface SqlDialect<Tx = unknown> {
	// ── Connection ──────────────────────────────────────────────────────────────

	/** Opens the connection pool to the database. */
	connect(): Promise<void>;

	/** Closes the connection pool gracefully. */
	disconnect(): Promise<void>;

	// ── Transactions ─────────────────────────────────────────────────────────────

	/**
	 * Wraps the callback in a BEGIN/COMMIT transaction.
	 * Rolls back automatically on error and re-throws the original error.
	 * `opts.isolationLevel` overrides the default (READ COMMITTED).
	 */
	transaction<T>(fn: (tx: Tx) => Promise<T>, opts?: TransactionOptions): Promise<T>;

	// ── Sandbox context ──────────────────────────────────────────────────────────

	/**
	 * Sets the per-transaction sandbox context so RLS policies and stored procedures
	 * can scope queries to the current sandbox. Does NOT acquire any advisory lock —
	 * safe to call from read-only paths (cold-start loads, cache reloads) without
	 * serializing against unrelated writers.
	 *
	 * Writers must call `setSandboxContextWithLock` instead.
	 */
	setSandboxContext(tx: Tx, sandboxId: string): Promise<void>;

	/**
	 * Like `setSandboxContext` but also acquires the per-sandbox advisory lock
	 * (`pg_advisory_xact_lock`) so cross-replica writers serialize at the DB layer.
	 *
	 * The lock is transaction-scoped — auto-released on COMMIT/ROLLBACK — and
	 * compatible with transaction-mode connection pooling (pgbouncer, Neon pooler).
	 *
	 * Call this from every write path. Read-only paths should use
	 * `setSandboxContext` to avoid blocking writers unnecessarily.
	 */
	setSandboxContextWithLock(tx: Tx, sandboxId: string): Promise<void>;

	// ── Sandbox lifecycle ─────────────────────────────────────────────────────────

	/**
	 * Creates a new sandbox: inserts a root inode (kind=2, mode=0o755),
	 * inserts the sandboxes row, and creates default directories
	 * (/home, /home/user, /tmp, /bin).
	 * Returns the root inode ID and the DB-generated creation timestamp (ISO-8601).
	 */
	createSandbox(tx: Tx, sandboxId: string, owner?: string): Promise<{ rootInodeId: bigint; createdAt: string }>;

	/**
	 * Deletes a sandbox and all associated inodes, dirents, and blobs
	 * by deleting the sandbox row (CASCADE removes child rows).
	 */
	deleteSandbox(tx: Tx, sandboxId: string): Promise<void>;

	/**
	 * Returns true if a sandbox row with the given ID exists in the database.
	 * Does not require sandbox context (no RLS dependency) — queries sandboxes table directly.
	 */
	sandboxExists(tx: Tx, sandboxId: string): Promise<boolean>;

	/** Returns persisted metadata for a sandbox, or null if the sandbox doesn't exist. */
	getSandboxMeta(tx: Tx, sandboxId: string): Promise<SandboxMeta | null>;

	/** Writes owner and runtime-option metadata to the sandbox row. */
	updateSandboxMeta(tx: Tx, sandboxId: string, meta: SandboxMeta): Promise<void>;

	/** Lists all sandboxes, optionally filtered by owner. */
	listSandboxes(tx: Tx, owner?: string): Promise<SandboxListEntry[]>;

	// ── Inode CRUD ────────────────────────────────────────────────────────────────

	/**
	 * Inserts a new inode into the database.
	 * Returns the generated bigint inode ID.
	 */
	createInode(tx: Tx, opts: CreateInodeOpts): Promise<bigint>;

	/**
	 * Retrieves a single inode by ID.
	 * Returns null if the inode does not exist.
	 */
	getInode(tx: Tx, inodeId: bigint): Promise<InodeRow | null>;

	/**
	 * Updates mutable inode fields (mode, size, mtime, contentSha256).
	 * Only the fields present in `updates` are written; others are untouched.
	 */
	updateInode(tx: Tx, inodeId: bigint, updates: UpdateInodeOpts): Promise<void>;

	/**
	 * Hard-deletes an inode row by ID.
	 */
	deleteInode(tx: Tx, inodeId: bigint): Promise<void>;

	// ── Hardlink counts ──────────────────────────────────────────────────────────

	/**
	 * Atomically increments nlink by 1.
	 * Executes UPDATE inodes SET nlink = nlink + 1 WHERE id = $1.
	 */
	incrementNlink(tx: Tx, inodeId: bigint): Promise<void>;

	/**
	 * Atomically decrements nlink by 1 and returns the new nlink value.
	 * Executes UPDATE inodes SET nlink = nlink - 1 WHERE id = $1 RETURNING nlink.
	 */
	decrementNlink(tx: Tx, inodeId: bigint): Promise<number>;

	// ── Dirent CRUD ──────────────────────────────────────────────────────────────

	/**
	 * Inserts a directory entry linking `name` under `parentId` to `inodeId`.
	 * Throws a translatable EEXIST error if (parentId, name) already exists.
	 */
	insertDirent(tx: Tx, parentId: bigint, name: string, inodeId: bigint): Promise<void>;

	/**
	 * Insert-or-replace a directory entry atomically using
	 * INSERT ... ON CONFLICT (parent_inode_id, name) DO UPDATE SET inode_id.
	 * Returns the previously-referenced inodeId if a replacement occurred,
	 * or null if this was a fresh insert.
	 */
	upsertDirent(tx: Tx, parentId: bigint, name: string, inodeId: bigint): Promise<bigint | null>;

	/**
	 * Deletes the directory entry (parentId, name) and returns the removed inodeId.
	 * Throws a translatable ENOENT error if the entry does not exist.
	 */
	deleteDirent(tx: Tx, parentId: bigint, name: string): Promise<bigint>;

	/**
	 * Lists all directory entries under `parentId`, ordered by name.
	 */
	listDirents(tx: Tx, parentId: bigint): Promise<DirentRow[]>;

	/**
	 * Moves/renames a directory entry in a single UPDATE.
	 * If the destination (newParentId, newName) already exists, deletes it first
	 * within the same transaction.
	 * Throws a translatable ENOENT error if the source does not exist.
	 */
	moveDirent(tx: Tx, oldParentId: bigint, oldName: string, newParentId: bigint, newName: string): Promise<void>;

	// ── Composite write operations (optional) ────────────────────────────────────

	mkdirComposite?(tx: Tx, sandboxId: string, parentId: bigint, name: string, mode: number): Promise<bigint>;

	rmComposite?(tx: Tx, sandboxId: string, parentId: bigint, name: string): Promise<bigint>;

	writeFileComposite?(
		tx: Tx,
		sandboxId: string,
		parentId: bigint,
		name: string,
		mode: number,
		size: number,
		sha256: Uint8Array,
		data: Uint8Array,
	): Promise<bigint>;

	mvComposite?(
		tx: Tx,
		sandboxId: string,
		oldParentId: bigint,
		oldName: string,
		newParentId: bigint,
		newName: string,
	): Promise<void>;

	// ── Blob storage ──────────────────────────────────────────────────────────────

	/**
	 * Stores a content-addressable blob keyed by its SHA-256 hash.
	 * Uses INSERT ... ON CONFLICT (sha256) DO NOTHING for global deduplication.
	 */
	upsertBlob(tx: Tx, sha256: Uint8Array, data: Uint8Array): Promise<void>;

	/**
	 * Retrieves blob content by its SHA-256 hash.
	 * Returns null if no blob with that hash exists.
	 */
	getBlob(tx: Tx, sha256: Uint8Array): Promise<Uint8Array | null>;

	/**
	 * Like `getBlob` but issues a single pool-level SELECT with no surrounding
	 * transaction. Safe because the `blobs` table is global (no `sandbox_id`,
	 * no RLS policy — see migrations/postgres/0000_create_tables.sql:40-44),
	 * so the `app.sandbox_id` setting is meaningless on this read.
	 *
	 * Use from read paths (`readFile` / `readFileBuffer`) where eliminating the
	 * BEGIN/SET LOCAL/COMMIT envelope removes 3 of 4 RTTs per cache miss.
	 * Writers must keep using the in-transaction `getBlob` so the bytes they
	 * fetch are consistent with the inode mutations they're about to make.
	 *
	 * Returns null if no blob with the given hash exists.
	 */
	getBlobNoTx(sha256: Uint8Array): Promise<Uint8Array | null>;

	/**
	 * Bulk-fetches blob contents for file inodes in the sandbox, ordered
	 * smallest-first under a `maxBytes` running-total cap. Used to prewarm the
	 * in-memory content cache in one round-trip.
	 *
	 * Smallest-first matters: a 50 MB cap consumed by one 50 MB file gives
	 * agents no coverage; the same cap consumed by 5000 small files makes most
	 * greps free.
	 *
	 * Returns one entry per qualifying inode (two inodes sharing a blob both
	 * appear). Implementations should prefer Redis L2 over Postgres for misses.
	 */
	getBlobsForSandbox(sandboxId: string, maxBytes: number): Promise<Array<{ inodeId: bigint; data: Uint8Array }>>;

	/**
	 * Deletes orphan blobs — those whose sha256 is not referenced by any inode's
	 * content_sha256 — that are older than the `minAgeMs` grace window.
	 *
	 * `minAgeMs` is the grace window in milliseconds: orphans whose
	 * `last_referenced_at` is younger than this are kept (they may be re-adopted
	 * by an in-flight dedup upsert). A NULL `last_referenced_at` is treated as
	 * ancient and is always eligible for collection. Pass `0` to collect every
	 * orphan immediately.
	 *
	 * Returns the sha256s of the deleted blobs (for later cache invalidation).
	 */
	gcOrphanBlobs(tx: Tx, minAgeMs: number): Promise<Uint8Array[]>;

	// ── Bulk / tree operations ────────────────────────────────────────────────────

	/**
	 * Loads the complete path tree for the current sandbox in one recursive CTE
	 * query, starting from the sandbox root inode.
	 * Used to populate SqlFs.pathCache at session start.
	 * The root directory is included with path '/'.
	 * Returns one entry per filesystem node with its absolute path and metadata.
	 */
	loadAllPaths(tx: Tx): Promise<Array<{ path: string } & PathCacheEntry>>;

	/**
	 * Collects all inode IDs within the subtree rooted at `rootInodeId`,
	 * including the root itself, using a recursive CTE.
	 * Used by rm -r to gather all inodes for bulk deletion.
	 */
	loadSubtreeInodes(tx: Tx, rootInodeId: bigint): Promise<bigint[]>;

	/**
	 * Bulk-inserts files into the current sandbox in minimal round-trips,
	 * creating all missing parent directories automatically.
	 * Prefers multi-row INSERT statements for blobs and inodes.
	 */
	bulkIngest(tx: Tx, files: BulkIngestFile[]): Promise<Map<string, PathCacheEntry>>;

	// ── Path resolution ───────────────────────────────────────────────────────────

	/**
	 * Resolves an absolute `path` string to an inode ID by walking path components
	 * and following symlinks (via the dialect's fs_resolve stored procedure or
	 * equivalent).
	 *
	 * Symlinks on intermediate components are always followed.
	 * The final component is followed only when `followLast` is true.
	 *
	 * Throws ENOENT if any component is missing, ENOTDIR if a non-directory
	 * appears mid-path, or ELOOP if circular symlinks are detected.
	 */
	resolvePath(tx: Tx, path: string, followLast: boolean): Promise<bigint>;
}
