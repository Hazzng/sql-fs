/**
 * SqlFs: IFileSystem implementation backed by a SQL dialect.
 * Caches the full path tree in memory (pathCache) and file content (contentCache).
 *
 * US-019: pathCache initialization from loadAllPaths
 * US-020: pathCache update on write operations
 * US-022: LRU content cache setup
 */

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";
import { LRUCache } from "lru-cache";

import { readOnlyContext } from "../../api/read-only-context.js";
import { runTrustedDbAsync } from "./defense.js";
import {
	createEexist,
	createEinval,
	createEisdir,
	createEnoent,
	createEnotdir,
	createEnotempty,
	createEperm,
	createEreadonly,
} from "./errors.js";
import type { RedisBlobCache } from "./redis-blob-cache.js";
import { type RedisPathSnapshot, versionKey } from "./redis-path-snapshot.js";
import { type BulkIngestFile, INODE_KIND, type PathCacheEntry, type SqlDialect } from "./types.js";

/**
 * Normalize a virtual filesystem path: resolve `.` and `..` components,
 * collapse slashes, always return an absolute path starting with `/`.
 * Matches just-bash's internal path-utils semantics (not publicly exported).
 */
function normalizeFsPath(p: string): string {
	if (!p || p === "/") return "/";
	const s = p.startsWith("/") ? p : `/${p}`;
	const parts = s.split("/").filter((seg) => seg && seg !== ".");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return `/${stack.join("/")}`;
}

/**
 * Normalize and validate a path. Rejects null bytes (security risk).
 * Throws EINVAL for invalid paths.
 */
function validatePath(p: string): string {
	if (p.includes("\0")) {
		throw createEinval(p);
	}
	return normalizeFsPath(p);
}

// Extract optional-parameter types from IFileSystem to avoid importing
// from just-bash internal paths (ReadFileOptions, WriteFileOptions, DirentEntry are not
// publicly re-exported from the just-bash main entry point).
type ReadFileOpts = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOpts = Parameters<IFileSystem["writeFile"]>[2];
type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>>[number];

const DEFAULT_CONTENT_CACHE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

interface SqlFsOptions<Tx> {
	readonly dialect: SqlDialect<Tx>;
	readonly sandboxId: string;
	/** Tenant identifier — used to build tenant-prefixed Redis keys (Phase 3). */
	readonly tenantId?: string;
	/** Max total byte budget for the content cache. Default: 50 MB. */
	readonly contentCacheMaxBytes?: number;
	/** Allow symlink() to create symlinks. Default: false (EPERM). */
	readonly allowSymlinks?: boolean;
	/**
	 * Optional Redis client used to read the per-sandbox version counter
	 * (`vfs:{tenantId}:ver:{sandboxId}`) during cold-start / reload. Required
	 * together with `pathSnapshot` for snapshot-backed cold starts (Phase E).
	 */
	readonly redis?: Redis;
	/** Redis path snapshot — tried before `loadAllPaths` when `redis` is also set. */
	readonly pathSnapshot?: RedisPathSnapshot;
	/**
	 * Tenant-scoped Redis blob cache. When set alongside `pathSnapshot`, a
	 * synchronous `mget` pre-populates `contentCache` on snapshot hit before
	 * `ready()` returns — eliminating the race window between session handoff
	 * and background prewarm completion.
	 */
	readonly blobCache?: RedisBlobCache;
}

/**
 * Narrow extension of `IFileSystem` with cache-coherence affordances used by
 * `SessionManager` for cross-replica reload-on-handoff (Phase D).
 *
 * `SqlFs` satisfies this interface. The `memory` backend (InMemoryFs) does
 * NOT — call sites must guard via `"reload" in fs` before casting.
 */
export interface ICoherentFs extends IFileSystem {
	/** Drops all in-memory caches and repopulates from the source of truth. */
	reload(): Promise<void>;
	/** True iff at least one mutation has run since the last clearDirty. */
	wasDirty(): boolean;
	/** Resets the dirty flag — called after publishing a new version. */
	clearDirty(): void;
	/**
	 * Bulk-inserts files into the sandbox in minimal DB round-trips, creating
	 * any missing parent directories. After commit, repopulates the in-memory
	 * pathCache via reload() and marks the FS dirty.
	 */
	bulkIngest(files: BulkIngestFile[]): Promise<void>;
}

export interface IScriptTxFs extends ICoherentFs {
	beginScriptScope(): void;
	endScriptScope(): Promise<void>;
	abortScriptScope(): Promise<void>;
	readonly scriptScopeActive: boolean;
	readonly scriptTxOpen: boolean;
}

/**
 * Read-only scope hooks used by the parallel-readOnly bash exec path. While
 * the scope is active every mutating method on the filesystem throws
 * EREADONLY immediately — the offending bash command fails fast and no
 * partial state escapes to other concurrent readers.
 *
 * Reference-counted: every concurrent reader calls `beginReadOnlyScope`
 * on entry and `endReadOnlyScope` on exit. The scope stays active while
 * any reader holds it. Violation attribution is per-call via the
 * `readOnlyContext` AsyncLocalStorage rather than an FS-level flag, so
 * a lying script in one reader cannot falsely flag innocent readers
 * sharing the same FS.
 */
export interface IReadOnlyScopeFs extends IFileSystem {
	beginReadOnlyScope(): void;
	endReadOnlyScope(): void;
	readonly readOnlyScopeActive: boolean;
}

export class SqlFs<Tx = unknown> implements ICoherentFs, IReadOnlyScopeFs {
	readonly #dialect: SqlDialect<Tx>;
	readonly #sandboxId: string;
	readonly #tenantId: string;
	readonly #pathCache: Map<string, PathCacheEntry>;
	readonly #contentCache: LRUCache<bigint, Uint8Array>;
	readonly #allowSymlinks: boolean;
	readonly #redis: Redis | undefined;
	readonly #pathSnapshot: RedisPathSnapshot | undefined;
	readonly #blobCache: RedisBlobCache | undefined;
	#dirty = false;
	/**
	 * Single-flight guard for `reload()` — deduplicates concurrent reload calls
	 * so a thundering herd across callers does not issue N loadAllPaths queries
	 * against the DB simultaneously.
	 */
	#pendingReload: Promise<void> | undefined;
	/**
	 * In-flight prewarm task. Read by `readFile`/`readFileBuffer` cache-miss
	 * paths to coalesce reads onto the batched fetch instead of racing it with
	 * per-file SELECTs.
	 */
	#prewarmInFlight: Promise<void> | undefined;
	/**
	 * One-shot follow-up requested while a prewarm is already running.
	 * Used when reload() clears contentCache during an in-flight prewarm.
	 */
	#prewarmQueued = false;
	#scriptScope = false;
	#scriptTx: Tx | undefined;
	#scriptTxEnd: (() => void) | undefined;
	#scriptTxAbort: ((err: Error) => void) | undefined;
	#scriptTxPromise: Promise<void> | undefined;
	#readOnlyDepth = 0;

	constructor(opts: SqlFsOptions<Tx>) {
		this.#dialect = opts.dialect;
		this.#sandboxId = opts.sandboxId;
		this.#tenantId = opts.tenantId ?? "default";
		this.#allowSymlinks = opts.allowSymlinks ?? false;
		this.#redis = opts.redis;
		this.#pathSnapshot = opts.pathSnapshot;
		this.#blobCache = opts.blobCache;
		this.#pathCache = new Map();
		this.#contentCache = new LRUCache<bigint, Uint8Array>({
			maxSize: opts.contentCacheMaxBytes ?? DEFAULT_CONTENT_CACHE_MAX_BYTES,
			sizeCalculation: (value) => value.byteLength,
		});
	}

	/** @internal exposed for the Redis path-snapshot writer (Phase E). */
	_getPathCache(): Map<string, PathCacheEntry> {
		return this.#pathCache;
	}

	async disconnect(): Promise<void> {
		await this.#dialect.disconnect();
	}

	// ── Dirty tracking (Phase D) ──────────────────────────────────────────────

	wasDirty(): boolean {
		return this.#dirty;
	}

	clearDirty(): void {
		this.#dirty = false;
	}

	// ── Transaction helper ────────────────────────────────────────────────────────

	async #withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		if (this.#scriptScope) {
			if (this.#scriptTx === undefined) {
				await this.#openScriptTx();
			}
			const tx = this.#scriptTx as Tx;
			return runTrustedDbAsync(() => fn(tx));
		}
		return runTrustedDbAsync(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				return await fn(tx);
			}),
		);
	}

	/**
	 * Read-only transaction helper. Sets the RLS sandbox context but skips the
	 * advisory lock so pure reads do NOT queue behind concurrent writers on the
	 * same sandbox. Use for getBlob / resolvePath paths that only serve reads.
	 */
	async #withReadTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		const scriptTx = this.#scriptTx;
		if (this.#scriptScope && scriptTx !== undefined) {
			return runTrustedDbAsync(() => fn(scriptTx));
		}
		return runTrustedDbAsync(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContext(tx, this.#sandboxId);
				return await fn(tx);
			}),
		);
	}

	async #openScriptTx(): Promise<void> {
		let resolveTxReady!: () => void;
		const txReady = new Promise<void>((r) => {
			resolveTxReady = r;
		});

		let resolveEnd!: () => void;
		let rejectEnd!: (err: Error) => void;
		const endPromise = new Promise<void>((resolve, reject) => {
			resolveEnd = resolve;
			rejectEnd = reject;
		});
		this.#scriptTxEnd = resolveEnd;
		this.#scriptTxAbort = rejectEnd;

		const scriptTxPromise = runTrustedDbAsync(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				this.#scriptTx = tx;
				resolveTxReady();
				await endPromise;
			}),
		);
		this.#scriptTxPromise = scriptTxPromise;
		// Guard against unhandled rejection if the connection closes before endScriptScope/abortScriptScope.
		// endScriptScope still sees the rejection via `await this.#scriptTxPromise` because .catch() creates
		// a new derived chain without affecting the original promise's rejected state.
		scriptTxPromise.catch(() => {});

		// Race txReady against #scriptTxPromise so that a connection failure before
		// setSandboxContextWithLock completes (i.e. before resolveTxReady fires) propagates
		// immediately rather than leaving this call hanging forever.
		await Promise.race([txReady, this.#scriptTxPromise]);
	}

	async #withBareTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		// Composite write methods include their own set_config + pg_advisory_xact_lock in their SQL.
		// Inside a script scope every write MUST run on the single script-tx so the
		// whole script (or batch — audit H10) commits or rolls back atomically. The
		// script-tx is opened lazily here on the first composite write; the advisory
		// lock is re-entrant within that transaction, so routing subsequent composites
		// through it cannot deadlock. Starting a *fresh* transaction here while a
		// scope is active would (a) auto-commit the write outside the scope — breaking
		// atomicity — and (b) deadlock against the script-tx's advisory lock.
		if (this.#scriptScope) {
			if (this.#scriptTx === undefined) {
				await this.#openScriptTx();
			}
			const scriptTx = this.#scriptTx as Tx;
			return runTrustedDbAsync(() => fn(scriptTx));
		}
		// No active scope — use a fresh, self-committing transaction (original
		// behavior, no extra round-trip).
		return runTrustedDbAsync(() => this.#dialect.transaction(fn));
	}

	// ── Path helpers ──────────────────────────────────────────────────────────────

	/** Returns the parent path of an absolute path. '/' has no parent. */
	#parentOf(path: string): string {
		const idx = path.lastIndexOf("/");
		if (idx === 0) return "/";
		return path.slice(0, idx);
	}

	/** Returns the base name component of an absolute path. */
	#nameOf(path: string): string {
		return path.slice(path.lastIndexOf("/") + 1);
	}

	/** Returns all pathCache paths that are direct children of the given dir path. */
	#childPaths(dirPath: string): string[] {
		const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
		const result: string[] = [];
		for (const key of this.#pathCache.keys()) {
			if (key === dirPath) continue;
			if (!key.startsWith(prefix)) continue;
			// Direct child: no additional slash after prefix
			const rest = key.slice(prefix.length);
			if (!rest.includes("/")) result.push(key);
		}
		return result;
	}

	/**
	 * Applies a metadata patch to EVERY pathCache entry sharing `inodeId`.
	 * Audit M9: chmod/utimes change the inode, so all hardlink siblings (distinct
	 * paths, same inode) must reflect the new mode/mtime — not just the one path
	 * the call named.
	 */
	#updateCacheByInode(inodeId: bigint, patch: Partial<PathCacheEntry>): void {
		for (const [p, e] of this.#pathCache) {
			if (e.inodeId === inodeId) this.#pathCache.set(p, { ...e, ...patch });
		}
	}

	/** Returns all pathCache paths rooted at dirPath (inclusive). */
	#allPathsUnder(dirPath: string): string[] {
		const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
		const result: string[] = [dirPath];
		for (const key of this.#pathCache.keys()) {
			if (key !== dirPath && key.startsWith(prefix)) result.push(key);
		}
		return result;
	}

	/**
	 * Resolves a path to a readable inode entry, following symlinks.
	 * Returns the final (non-symlink) PathCacheEntry.
	 * Throws ENOENT if the path or its symlink target is missing from cache.
	 * Throws ELOOP (via dialect.resolvePath) if a symlink loop is detected.
	 */
	async #resolveReadEntry(path: string): Promise<PathCacheEntry> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind !== INODE_KIND.SYMLINK) return entry;

		// Follow symlink via dialect path resolver — ELOOP/ENOENT propagate naturally.
		// Read-only resolution: skip the per-sandbox advisory lock so reads
		// don't queue behind writers.
		const resolvedId = await this.#withReadTx((tx) => this.#dialect.resolvePath(tx, path, true));
		for (const [, e] of this.#pathCache) {
			if (e.inodeId === resolvedId) return e;
		}
		// Resolved inode is not in pathCache → broken symlink
		throw createEnoent(path);
	}

	/**
	 * Validates that the parent directory of `path` exists and is a directory.
	 * Returns parentPath, name, and the parent's PathCacheEntry.
	 * Throws ENOENT if the parent is missing, ENOTDIR if the parent is not a directory.
	 */
	#requireParentDir(path: string): { parentPath: string; name: string; parentEntry: PathCacheEntry } {
		const parentPath = this.#parentOf(path);
		const name = this.#nameOf(path);
		const parentEntry = this.#pathCache.get(parentPath);
		if (!parentEntry) throw createEnoent(parentPath);
		if (parentEntry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(parentPath);
		return { parentPath, name, parentEntry };
	}

	/**
	 * Loads the full path tree from the DB without touching in-memory caches.
	 * Used by `ready()` (initial load) and `reload()` (cross-replica refresh).
	 * On error the caller's caches are left untouched.
	 *
	 * Phase E: when `redis` and `pathSnapshot` are both configured, try a
	 * snapshot read first. The embedded `version` must equal the current
	 * `vfs:{tenantId}:ver:{sandboxId}` counter exactly (Edge Case §3); any mismatch,
	 * miss, or Redis error falls through to `dialect.loadAllPaths`.
	 */
	async #loadFreshPathCache(): Promise<{ entries: Map<string, PathCacheEntry>; fromSnapshot: boolean }> {
		let missReason: "disabled" | "no_key" | "version_mismatch" | "error" = "disabled";
		if (this.#redis !== undefined && this.#pathSnapshot !== undefined) {
			try {
				const raw = await this.#redis.get(versionKey(this.#tenantId, this.#sandboxId));
				const currentVersion = raw === null ? 0 : Number(raw) || 0;
				const snap = await this.#pathSnapshot.read(this.#tenantId, this.#sandboxId);
				if (snap === null) {
					missReason = "no_key";
				} else if (snap.version !== currentVersion) {
					missReason = "version_mismatch";
				} else {
					console.log(
						JSON.stringify({
							event: "path_snapshot_hit",
							sandboxId: this.#sandboxId,
							version: currentVersion,
							entries: snap.entries.size,
						}),
					);
					return { entries: snap.entries, fromSnapshot: true };
				}
			} catch (err) {
				missReason = "error";
				console.error(
					JSON.stringify({
						event: "snapshot_version_check_error",
						sandboxId: this.#sandboxId,
						error: (err as Error).message,
					}),
				);
			}
		}
		console.log(JSON.stringify({ event: "path_snapshot_miss", sandboxId: this.#sandboxId, reason: missReason }));
		const rows = await this.#dialect.transaction(async (tx) => {
			await this.#dialect.setSandboxContext(tx, this.#sandboxId);
			return await this.#dialect.loadAllPaths(tx);
		});
		const fresh = new Map<string, PathCacheEntry>();
		for (const { path, ...entry } of rows) {
			fresh.set(path, entry);
		}
		return { entries: fresh, fromSnapshot: false };
	}

	/**
	 * Synchronously pre-populates `#contentCache` from Redis blob cache using a
	 * single `mget` round-trip. Called on snapshot hit before `ready()` returns,
	 * eliminating the race window where exec reads files before background
	 * prewarm completes. Fails open: any Redis error is logged; background
	 * prewarm covers the rest via Postgres.
	 */
	async #prefetchBlobsFromSnapshot(entries: Map<string, PathCacheEntry>): Promise<void> {
		if (this.#blobCache === undefined) return;
		const inodeIds: bigint[] = [];
		const sha256s: Uint8Array[] = [];
		for (const entry of entries.values()) {
			if (entry.kind === INODE_KIND.FILE && entry.contentSha256 !== null) {
				inodeIds.push(entry.inodeId);
				sha256s.push(entry.contentSha256);
			}
		}
		if (sha256s.length === 0) return;
		const blobs = await this.#blobCache.mget(sha256s);
		let hits = 0;
		for (let i = 0; i < blobs.length; i++) {
			const data = blobs[i];
			if (data != null && data.byteLength > 0) {
				this.#contentCache.set(inodeIds[i]!, data);
				hits++;
			}
		}
		console.log(
			JSON.stringify({
				event: "snapshot_blob_prefetch_ok",
				sandboxId: this.#sandboxId,
				requested: sha256s.length,
				hits,
			}),
		);
	}

	#startPrewarm(queueIfRunning = false): void {
		if (this.#prewarmInFlight !== undefined) {
			if (queueIfRunning) this.#prewarmQueued = true;
			return;
		}
		const cap = this.#contentCache.maxSize;
		const task = (async (): Promise<void> => {
			try {
				const blobs = await runTrustedDbAsync(() => this.#dialect.getBlobsForSandbox(this.#sandboxId, cap));
				for (const { inodeId, data } of blobs) {
					if (data.byteLength > 0) this.#contentCache.set(inodeId, data);
				}
				console.log(JSON.stringify({ event: "content_prewarm_ok", sandboxId: this.#sandboxId, entries: blobs.length }));
			} catch (err) {
				// Non-fatal: lazy fetch via getBlobNoTx still works.
				console.error(
					JSON.stringify({
						event: "content_prewarm_error",
						sandboxId: this.#sandboxId,
						error: (err as Error).message,
					}),
				);
			} finally {
				this.#prewarmInFlight = undefined;
				if (this.#prewarmQueued) {
					this.#prewarmQueued = false;
					this.#startPrewarm();
				}
			}
		})();
		this.#prewarmInFlight = task;
	}

	/**
	 * Initialises the in-memory pathCache by loading all paths from the DB
	 * via a single recursive CTE query.  Must be called once before any FS op.
	 */
	async ready(): Promise<void> {
		// Speculative background Postgres prewarm starts in parallel with pathCache
		// load. Covers blobs not in Redis and the non-snapshot path.
		this.#startPrewarm();

		const { entries, fromSnapshot } = await this.#loadFreshPathCache();
		this.#pathCache.clear();
		for (const [p, e] of entries) this.#pathCache.set(p, e);

		// On snapshot hit: synchronous Redis mget pre-populates contentCache before
		// this method returns, eliminating the race window for Redis-cached blobs.
		// Only fires when both REDIS_PATH_SNAPSHOT_ENABLED and REDIS_BLOB_CACHE_ENABLED
		// are true (i.e. pathSnapshot and blobCache are both configured).
		if (fromSnapshot) {
			await this.#prefetchBlobsFromSnapshot(entries);
		}
	}

	/**
	 * Drops the in-memory caches and repopulates `#pathCache` from the database.
	 * Used on cross-replica cache-version mismatch (Phase D).
	 *
	 * Atomicity: the fresh snapshot is loaded BEFORE the existing caches are
	 * cleared. If the DB call throws, the old caches remain intact so readers
	 * do not see a temporary empty state (which would return ENOENT for
	 * everything until the next successful reload).
	 *
	 * Concurrency: deduplicated via `#pendingReload` so simultaneous callers
	 * share a single DB round trip.
	 */
	async reload(): Promise<void> {
		if (this.#pendingReload !== undefined) {
			return this.#pendingReload;
		}
		const p = (async (): Promise<void> => {
			try {
				const { entries } = await this.#loadFreshPathCache();
				this.#pathCache.clear();
				for (const [path, entry] of entries) this.#pathCache.set(path, entry);
				this.#contentCache.clear();
				this.#dirty = false;
				this.#startPrewarm(true);
			} finally {
				this.#pendingReload = undefined;
			}
		})();
		this.#pendingReload = p;
		return p;
	}

	// ── Script-scoped transaction (lazy) ─────────────────────────────────────────

	get scriptScopeActive(): boolean {
		return this.#scriptScope;
	}

	get scriptTxOpen(): boolean {
		return this.#scriptTx !== undefined;
	}

	beginScriptScope(): void {
		if (this.#scriptScope) {
			throw new Error("beginScriptScope: a script scope is already active");
		}
		this.#scriptScope = true;
	}

	// ── Read-only scope (parallel readOnly bash exec) ────────────────────────────

	get readOnlyScopeActive(): boolean {
		return this.#readOnlyDepth > 0;
	}

	/**
	 * Reference-counted: every concurrent reader bumps the depth, the last
	 * one to exit clears it. The shared SqlFs is mutation-locked while any
	 * reader holds a scope. Per-cohort violation attribution is delegated
	 * to `readOnlyContext` (AsyncLocalStorage) so a lying script in one
	 * reader never falsely flags innocent concurrent readers.
	 */
	beginReadOnlyScope(): void {
		this.#readOnlyDepth++;
	}

	endReadOnlyScope(): void {
		if (this.#readOnlyDepth === 0) {
			throw new Error("endReadOnlyScope: no active read-only scope");
		}
		this.#readOnlyDepth--;
	}

	#assertWritable(path: string, op: string): void {
		if (this.#readOnlyDepth > 0) {
			const ctx = readOnlyContext.getStore();
			if (ctx !== undefined) ctx.violated = true;
			throw createEreadonly(path, op);
		}
	}

	async endScriptScope(): Promise<void> {
		if (!this.#scriptScope) return;
		this.#scriptScope = false;

		const hadTx = this.#scriptTx !== undefined;
		try {
			if (this.#scriptTxEnd !== undefined) {
				this.#scriptTxEnd();
				await this.#scriptTxPromise;
			}
		} catch (err) {
			// COMMIT failed — Postgres rolled the transaction back, but the
			// in-memory caches still hold this script's uncommitted mutations.
			// Discard them by reloading the committed state and clearing the dirty
			// flag, so the session does NOT publish a version bump / path snapshot
			// of data that never landed in Postgres (audit H7). Re-throw so the
			// caller learns the write failed.
			if (hadTx) {
				try {
					await this.reload();
					this.clearDirty();
				} catch {
					// Reload also failed; the next ensureFreshCache probe will reload.
					// Fall through to surface the original COMMIT error.
				}
			}
			throw err;
		} finally {
			this.#scriptTx = undefined;
			this.#scriptTxEnd = undefined;
			this.#scriptTxAbort = undefined;
			this.#scriptTxPromise = undefined;
		}
	}

	async abortScriptScope(): Promise<void> {
		if (!this.#scriptScope) return;
		this.#scriptScope = false;

		const hadTx = this.#scriptTx !== undefined;
		const abort = this.#scriptTxAbort;
		const txPromise = this.#scriptTxPromise;
		this.#scriptTx = undefined;
		this.#scriptTxEnd = undefined;
		this.#scriptTxAbort = undefined;
		this.#scriptTxPromise = undefined;

		// Reject endPromise so the transaction callback throws → dialect issues ROLLBACK
		// and releases the connection/advisory lock. Without this the callback awaits
		// endPromise forever and the connection leaks until Postgres' idle timeout fires.
		if (abort !== undefined) abort(new Error("script-tx aborted"));
		if (txPromise !== undefined) txPromise.catch(() => {});

		if (hadTx) {
			// Audit L3: abortScriptScope runs from the exec error path
			// (`catch (err) { await abortScope(); throw err; }`). A reload() failure
			// here must NOT propagate and mask the caller's original exec error.
			// Swallow + log; the next ensureFreshCache probe reloads the cache.
			try {
				await this.reload();
				this.clearDirty();
			} catch (reloadErr) {
				console.error(
					JSON.stringify({
						event: "abort_scope_reload_error",
						sandboxId: this.#sandboxId,
						error: (reloadErr as Error).message,
					}),
				);
			}
		}
	}

	// `#dirty = true` must be set AFTER `reload()` because `reload()` clears it,
	// and `publishVersionIfDirty` at session-finalize needs to see dirty=true so
	// other replicas pick up the new tree.
	//
	// Every input path is normalized via `validatePath` (rejects null bytes,
	// resolves `.`/`..`) before reaching the dialect, matching the contract used
	// by every other write method on this class. Two inputs that normalize to
	// the same final path are rejected with EEXIST rather than silently
	// shadowing each other — the dialect would commit only one and drop the rest.
	async bulkIngest(files: BulkIngestFile[]): Promise<void> {
		if (files.length === 0) return;
		this.#assertWritable("/", "bulkIngest");
		const normalized: BulkIngestFile[] = [];
		const seen = new Set<string>();
		const bytesByPath = new Map<string, Uint8Array>();
		for (const file of files) {
			const path = validatePath(file.path);
			if (seen.has(path)) throw createEexist(path);
			seen.add(path);
			normalized.push({ path, content: file.content, mode: file.mode });
			bytesByPath.set(path, file.content);
		}
		const newEntries = await this.#withTx((tx) => this.#dialect.bulkIngest(tx, normalized));
		// Evict overwritten inodes from contentCache so stale content is never served.
		// Populate #contentCache with the bytes already in memory — next readFile is a Map lookup.
		for (const [path, entry] of newEntries) {
			const old = this.#pathCache.get(path);
			if (old !== undefined && old.inodeId !== entry.inodeId) {
				this.#contentCache.delete(old.inodeId);
			}
			this.#pathCache.set(path, entry);
			const bytes = bytesByPath.get(path);
			if (bytes !== undefined && bytes.byteLength > 0) {
				this.#contentCache.set(entry.inodeId, bytes);
			}
		}
		this.#dirty = true;
	}

	// ── IFileSystem: cache-served methods ────────────────────────────────────────

	getAllPaths(): string[] {
		return [...this.#pathCache.keys()];
	}

	// ── IFileSystem: write operations with pathCache updates ─────────────────────

	async writeFile(inputPath: string, content: FileContent, _options?: WriteFileOpts): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "writeFile");
		// Refuse to clobber an existing directory with a file (audit H2 #13). This
		// also rejects writing to "/" (the root is a directory), closing #25.
		if (this.#pathCache.get(path)?.kind === INODE_KIND.DIRECTORY) throw createEisdir(path);
		const { name, parentEntry } = this.#requireParentDir(path);

		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const sha256 = new Uint8Array(createHash("sha256").update(bytes).digest());
		const mtime = new Date();

		const inodeId = this.#dialect.writeFileComposite
			? await this.#withBareTx((tx) =>
					this.#dialect.writeFileComposite!(
						tx,
						this.#sandboxId,
						parentEntry.inodeId,
						name,
						0o644,
						bytes.length,
						sha256,
						bytes,
					),
				)
			: await this.#withTx(async (tx) => {
					await this.#dialect.upsertBlob(tx, sha256, bytes);
					const id = await this.#dialect.createInode(tx, {
						sandboxId: this.#sandboxId,
						kind: INODE_KIND.FILE,
						mode: 0o644,
						size: bytes.length,
						contentSha256: sha256,
					});
					const oldInodeId = await this.#dialect.upsertDirent(tx, parentEntry.inodeId, name, id);
					if (oldInodeId !== null) {
						const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
						if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
					}
					return id;
				});

		this.#pathCache.set(path, {
			inodeId,
			kind: INODE_KIND.FILE,
			mode: 0o644,
			size: bytes.length,
			mtime,
			contentSha256: sha256,
			symlinkTarget: null,
		});
		if (bytes.byteLength > 0) this.#contentCache.set(inodeId, bytes);
		this.#dirty = true;
	}

	async appendFile(inputPath: string, content: FileContent, _options?: WriteFileOpts): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "appendFile");
		// Refuse to clobber an existing directory (audit H2 #13); also rejects "/".
		if (this.#pathCache.get(path)?.kind === INODE_KIND.DIRECTORY) throw createEisdir(path);

		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const mtime = new Date();

		const existing = this.#pathCache.get(path);
		let fullBytes: Uint8Array;

		if (existing && existing.kind === INODE_KIND.FILE && existing.contentSha256 !== null) {
			const oldContent = await this.#withTx(async (tx) => this.#dialect.getBlob(tx, existing.contentSha256!));
			const base = oldContent ?? new Uint8Array(0);
			const merged = new Uint8Array(base.length + bytes.length);
			merged.set(base, 0);
			merged.set(bytes, base.length);
			fullBytes = merged;
		} else {
			fullBytes = bytes;
		}

		const sha256 = new Uint8Array(createHash("sha256").update(fullBytes).digest());
		const { name, parentEntry } = this.#requireParentDir(path);

		const inodeId = this.#dialect.writeFileComposite
			? await this.#withBareTx((tx) =>
					this.#dialect.writeFileComposite!(
						tx,
						this.#sandboxId,
						parentEntry.inodeId,
						name,
						0o644,
						fullBytes.length,
						sha256,
						fullBytes,
					),
				)
			: await this.#withTx(async (tx) => {
					await this.#dialect.upsertBlob(tx, sha256, fullBytes);
					const id = await this.#dialect.createInode(tx, {
						sandboxId: this.#sandboxId,
						kind: INODE_KIND.FILE,
						mode: 0o644,
						size: fullBytes.length,
						contentSha256: sha256,
					});
					const oldInodeId = await this.#dialect.upsertDirent(tx, parentEntry.inodeId, name, id);
					if (oldInodeId !== null) {
						const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
						if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
					}
					return id;
				});

		if (existing) this.#contentCache.delete(existing.inodeId);
		if (fullBytes.byteLength > 0) this.#contentCache.set(inodeId, fullBytes);
		this.#pathCache.set(path, {
			inodeId,
			kind: INODE_KIND.FILE,
			mode: 0o644,
			size: fullBytes.length,
			mtime,
			contentSha256: sha256,
			symlinkTarget: null,
		});
		this.#dirty = true;
	}

	async mkdir(inputPath: string, options?: MkdirOptions): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "mkdir");
		const recursive = options?.recursive ?? false;
		const mtime = new Date();

		if (recursive) {
			// Walk from root, creating missing segments
			const segments = path.split("/").filter(Boolean);
			let current = "/";
			let created = false;
			for (const seg of segments) {
				const next = current === "/" ? `/${seg}` : `${current}/${seg}`;
				if (!this.#pathCache.has(next)) {
					const parentEntry = this.#pathCache.get(current);
					if (!parentEntry) throw createEnoent(current);
					// Reject non-directory ancestors before any DB work. Otherwise
					// mkdir -p /a/b with /a as a file would silently insert a
					// dirent under the file's inode (dirents has no FK on kind).
					if (parentEntry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(current);
					const inodeId = await this.#withTx(async (tx) => {
						const id = await this.#dialect.createInode(tx, {
							sandboxId: this.#sandboxId,
							kind: INODE_KIND.DIRECTORY,
							mode: 0o755,
							size: 0,
						});
						await this.#dialect.insertDirent(tx, parentEntry.inodeId, seg, id);
						return id;
					});
					this.#pathCache.set(next, {
						inodeId,
						kind: INODE_KIND.DIRECTORY,
						mode: 0o755,
						size: 0,
						mtime,
						contentSha256: null,
						symlinkTarget: null,
					});
					created = true;
				}
				current = next;
			}
			if (created) this.#dirty = true;
			return;
		}

		// Non-recursive
		if (this.#pathCache.has(path)) throw createEexist(path);
		const { name, parentEntry } = this.#requireParentDir(path);

		const inodeId = this.#dialect.mkdirComposite
			? await this.#withBareTx((tx) =>
					this.#dialect.mkdirComposite!(tx, this.#sandboxId, parentEntry.inodeId, name, 0o755),
				)
			: await this.#withTx(async (tx) => {
					const id = await this.#dialect.createInode(tx, {
						sandboxId: this.#sandboxId,
						kind: INODE_KIND.DIRECTORY,
						mode: 0o755,
						size: 0,
					});
					await this.#dialect.insertDirent(tx, parentEntry.inodeId, name, id);
					return id;
				});

		this.#pathCache.set(path, {
			inodeId,
			kind: INODE_KIND.DIRECTORY,
			mode: 0o755,
			size: 0,
			mtime,
			contentSha256: null,
			symlinkTarget: null,
		});
		this.#dirty = true;
	}

	async rm(inputPath: string, options?: RmOptions): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "rm");
		const entry = this.#pathCache.get(path);

		if (!entry) {
			if (options?.force) return;
			throw createEnoent(path);
		}

		const parentPath = this.#parentOf(path);
		const name = this.#nameOf(path);
		const parentEntry = this.#pathCache.get(parentPath);

		if (options?.recursive && entry.kind === INODE_KIND.DIRECTORY) {
			// Snapshot subtree paths before async work; sort deepest-first (post-order)
			// so children are always processed before their parents.
			const subtreePaths = this.#allPathsUnder(path);
			subtreePaths.sort((a, b) => b.split("/").length - a.split("/").length);

			await this.#withTx(async (tx) => {
				// Step 1: unlink the subtree root from its parent
				if (parentEntry) {
					await this.#dialect.deleteDirent(tx, parentEntry.inodeId, name);
				}
				// Step 2: process each entry in post-order —
				//   • delete its internal dirent (for non-root entries)
				//   • decrement nlink; delete inode only when nlink reaches zero
				//   This preserves inodes still referenced by hardlinks outside the subtree.
				for (const p of subtreePaths) {
					const e = this.#pathCache.get(p)!;
					if (p !== path) {
						const pParentEntry = this.#pathCache.get(this.#parentOf(p));
						if (pParentEntry) {
							await this.#dialect.deleteDirent(tx, pParentEntry.inodeId, this.#nameOf(p));
						}
					}
					const newNlink = await this.#dialect.decrementNlink(tx, e.inodeId);
					if (newNlink === 0) await this.#dialect.deleteInode(tx, e.inodeId);
				}
			});

			// Update caches after successful DB operation
			for (const p of subtreePaths) {
				const e = this.#pathCache.get(p);
				if (e) this.#contentCache.delete(e.inodeId);
				this.#pathCache.delete(p);
			}
			this.#dirty = true;
			return;
		}

		if (entry.kind === INODE_KIND.DIRECTORY) {
			// Non-recursive: only allow if empty
			if (this.#childPaths(path).length > 0) throw createEnotempty(path);
		}

		if (this.#dialect.rmComposite) {
			await this.#withBareTx((tx) => this.#dialect.rmComposite!(tx, this.#sandboxId, parentEntry!.inodeId, name));
		} else {
			await this.#withTx(async (tx) => {
				const removedInodeId = await this.#dialect.deleteDirent(tx, parentEntry!.inodeId, name);
				const newNlink = await this.#dialect.decrementNlink(tx, removedInodeId);
				if (newNlink === 0) await this.#dialect.deleteInode(tx, removedInodeId);
			});
		}

		this.#contentCache.delete(entry.inodeId);
		this.#pathCache.delete(path);
		this.#dirty = true;
	}

	async chmod(inputPath: string, mode: number): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "chmod");
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		await this.#withTx(async (tx) => {
			await this.#dialect.updateInode(tx, entry.inodeId, { mode });
		});

		this.#updateCacheByInode(entry.inodeId, { mode });
		this.#dirty = true;
	}

	async utimes(inputPath: string, _atime: Date, mtime: Date): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "utimes");
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		await this.#withTx(async (tx) => {
			await this.#dialect.updateInode(tx, entry.inodeId, { mtime });
		});

		this.#updateCacheByInode(entry.inodeId, { mtime });
		this.#dirty = true;
	}

	// ── IFileSystem: stubs (implemented in later stories) ────────────────────────

	async #readBytes(inputPath: string): Promise<Uint8Array> {
		const path = validatePath(inputPath);
		// #resolveReadEntry follows symlinks; ENOENT/ELOOP propagate naturally
		const entry = await this.#resolveReadEntry(path);
		if (entry.kind === INODE_KIND.DIRECTORY) throw createEisdir(path);

		const cached = this.#contentCache.get(entry.inodeId);
		if (cached !== undefined) return cached;

		// Coalesce onto an in-flight prewarm fetch instead of racing it.
		if (this.#prewarmInFlight !== undefined) {
			await this.#prewarmInFlight;
			const afterPrewarm = this.#contentCache.get(entry.inodeId);
			if (afterPrewarm !== undefined) return afterPrewarm;
		}

		// `blobs` is global (no RLS), so a transaction wrapper is unnecessary.
		const data = await runTrustedDbAsync(() => this.#dialect.getBlobNoTx(entry.contentSha256!));
		const bytes = data ?? new Uint8Array(0);
		if (bytes.byteLength > 0) this.#contentCache.set(entry.inodeId, bytes);
		return bytes;
	}

	async readFile(inputPath: string, _options?: ReadFileOpts): Promise<string> {
		return new TextDecoder().decode(await this.#readBytes(inputPath));
	}

	async readFileBuffer(inputPath: string): Promise<Uint8Array> {
		return this.#readBytes(inputPath);
	}

	async exists(inputPath: string): Promise<boolean> {
		const path = validatePath(inputPath);
		return this.#pathCache.has(path);
	}

	async stat(inputPath: string): Promise<FsStat> {
		const path = validatePath(inputPath);
		const lentry = this.#pathCache.get(path);
		if (!lentry) throw createEnoent(path);

		// stat follows symlinks at the final component. Audit M7: the previous
		// one-hop `pathCache.get(symlinkTarget)` broke for relative targets (keys
		// are absolute) and multi-hop chains (returned an intermediate symlink).
		// Resolve through the dialect path resolver — the same one readFile and
		// realpath use — so relative/chained targets and loops are handled.
		const entry = lentry.kind === INODE_KIND.SYMLINK ? await this.#resolveReadEntry(path) : lentry;

		return {
			isFile: entry.kind === INODE_KIND.FILE,
			isDirectory: entry.kind === INODE_KIND.DIRECTORY,
			isSymbolicLink: false,
			mode: entry.mode,
			size: entry.size,
			mtime: entry.mtime,
		};
	}

	async lstat(inputPath: string): Promise<FsStat> {
		const path = validatePath(inputPath);
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		return {
			isFile: entry.kind === INODE_KIND.FILE,
			isDirectory: entry.kind === INODE_KIND.DIRECTORY,
			isSymbolicLink: entry.kind === INODE_KIND.SYMLINK,
			mode: entry.mode,
			size: entry.size,
			mtime: entry.mtime,
		};
	}

	async readdir(inputPath: string): Promise<string[]> {
		const path = validatePath(inputPath);
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(path);
		return this.#childPaths(path).map((p) => this.#nameOf(p));
	}

	readdirWithFileTypes(inputPath: string): Promise<DirentEntry[]> {
		const path = validatePath(inputPath);
		const entry = this.#pathCache.get(path);
		if (!entry) return Promise.reject(createEnoent(path));
		if (entry.kind !== INODE_KIND.DIRECTORY) return Promise.reject(createEnotdir(path));
		const children = this.#childPaths(path);
		const result: DirentEntry[] = children.map((p) => {
			const e = this.#pathCache.get(p)!;
			return {
				name: this.#nameOf(p),
				isFile: e.kind === INODE_KIND.FILE,
				isDirectory: e.kind === INODE_KIND.DIRECTORY,
				isSymbolicLink: e.kind === INODE_KIND.SYMLINK,
			};
		});
		return Promise.resolve(result);
	}

	async cp(inputSrc: string, inputDest: string, options?: CpOptions): Promise<void> {
		const src = validatePath(inputSrc);
		const dest = validatePath(inputDest);
		this.#assertWritable(dest, "cp");
		// Reject copying onto the root inode (empty basename) — would clobber "/"
		// in pathCache and persist a corrupt root cross-replica (audit H2 #25).
		if (this.#nameOf(dest) === "") throw createEisdir(dest);
		const srcEntry = this.#pathCache.get(src);
		if (!srcEntry) throw createEnoent(src);

		if (srcEntry.kind === INODE_KIND.DIRECTORY) {
			if (!options?.recursive) throw createEisdir(src);

			// Recursive directory copy: walk source subtree, create new inodes sharing same blobs
			const srcPaths = this.#allPathsUnder(src);
			// Sort by depth so parents are always created before their children
			srcPaths.sort((a, b) => a.split("/").length - b.split("/").length);

			// Validate dest parent exists and is a directory (throws if not)
			this.#requireParentDir(dest);

			const mtime = new Date();
			// Maps destPath → new inodeId so children can look up their parent's new id
			const newInodeIds = new Map<string, bigint>();

			await this.#withTx(async (tx) => {
				for (const srcPath of srcPaths) {
					const entry = this.#pathCache.get(srcPath)!;
					const destPath = dest + srcPath.slice(src.length);
					const entryName = this.#nameOf(destPath);
					const entryParent = this.#parentOf(destPath);

					// Parent is either a newly-created dir (newInodeIds) or an existing pathCache entry
					const parentInodeId = newInodeIds.get(entryParent) ?? this.#pathCache.get(entryParent)?.inodeId;
					if (parentInodeId === undefined) throw createEnoent(entryParent);

					const newId = await this.#dialect.createInode(tx, {
						sandboxId: this.#sandboxId,
						kind: entry.kind,
						mode: entry.mode,
						size: entry.size,
						contentSha256: entry.contentSha256,
						symlinkTarget: entry.symlinkTarget,
					});
					await this.#dialect.insertDirent(tx, parentInodeId, entryName, newId);
					newInodeIds.set(destPath, newId);
				}
			});

			// Update pathCache with all newly-created entries
			for (const [destPath, inodeId] of newInodeIds) {
				const srcPath = src + destPath.slice(dest.length);
				const srcE = this.#pathCache.get(srcPath)!;
				this.#pathCache.set(destPath, { ...srcE, inodeId, mtime });
			}
			this.#dirty = true;
			return;
		}

		// Single file copy: new inode pointing to the same blob (CAS dedup).
		// Refuse to clobber an existing directory with a file (audit H2).
		if (this.#pathCache.get(dest)?.kind === INODE_KIND.DIRECTORY) throw createEisdir(dest);
		const { name: destName, parentEntry: destParentEntry } = this.#requireParentDir(dest);

		const mtime = new Date();

		// Preserve the source inode's kind. Audit M8: forcing kind=FILE here turned
		// a copied symlink into a corrupt FILE inode (non-zero size, NULL content).
		// Copying a symlink preserves the link (target + size), matching the
		// recursive-cp path above.
		const newInodeId = await this.#withTx(async (tx) => {
			const id = await this.#dialect.createInode(tx, {
				sandboxId: this.#sandboxId,
				kind: srcEntry.kind,
				mode: srcEntry.mode,
				size: srcEntry.size,
				contentSha256: srcEntry.contentSha256,
				symlinkTarget: srcEntry.symlinkTarget,
			});
			const oldInodeId = await this.#dialect.upsertDirent(tx, destParentEntry.inodeId, destName, id);
			if (oldInodeId !== null) {
				const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
				if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
			}
			return id;
		});

		this.#pathCache.set(dest, {
			inodeId: newInodeId,
			kind: srcEntry.kind,
			mode: srcEntry.mode,
			size: srcEntry.size,
			mtime,
			contentSha256: srcEntry.contentSha256,
			symlinkTarget: srcEntry.symlinkTarget,
		});
		this.#dirty = true;
	}

	async mv(inputSrc: string, inputDest: string): Promise<void> {
		const src = validatePath(inputSrc);
		const dest = validatePath(inputDest);
		this.#assertWritable(dest, "mv");
		const srcEntry = this.#pathCache.get(src);
		if (!srcEntry) throw createEnoent(src);

		const srcParentPath = this.#parentOf(src);
		const srcName = this.#nameOf(src);
		const destParentPath = this.#parentOf(dest);
		const destName = this.#nameOf(dest);

		const srcParentEntry = this.#pathCache.get(srcParentPath);
		if (!srcParentEntry) throw createEnoent(srcParentPath);

		const destParentEntry = this.#pathCache.get(destParentPath);
		if (!destParentEntry) throw createEnoent(destParentPath);
		if (destParentEntry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(destParentPath);

		// Prevent moving a directory into its own descendant (would create a cycle)
		if (srcEntry.kind === INODE_KIND.DIRECTORY) {
			const srcPrefix = src === "/" ? "/" : `${src}/`;
			if (dest.startsWith(srcPrefix) || dest === src) {
				throw createEinval(src);
			}
		}

		// Capture displaced dest inode before async work
		const destEntry = this.#pathCache.get(dest);

		// Reject moving onto the root inode (empty basename) — would clobber "/"
		// (audit H2 #25).
		if (destName === "") throw createEisdir(dest);
		// Reject overwriting a non-empty directory: replacing its dirent here would
		// leave the destination's entire subtree orphaned in the DB and diverge the
		// cache (audit H2 #8). Mirrors rename(2) ENOTEMPTY.
		if (destEntry?.kind === INODE_KIND.DIRECTORY && this.#childPaths(dest).length > 0) {
			throw createEnotempty(dest);
		}

		if (this.#dialect.mvComposite) {
			await this.#withBareTx((tx) =>
				this.#dialect.mvComposite!(
					tx,
					this.#sandboxId,
					srcParentEntry.inodeId,
					srcName,
					destParentEntry.inodeId,
					destName,
				),
			);
		} else {
			await this.#withTx(async (tx) => {
				if (destEntry) {
					const newNlink = await this.#dialect.decrementNlink(tx, destEntry.inodeId);
					if (newNlink === 0) await this.#dialect.deleteInode(tx, destEntry.inodeId);
				}
				await this.#dialect.moveDirent(tx, srcParentEntry.inodeId, srcName, destParentEntry.inodeId, destName);
			});
		}

		// Snapshot src subtree before mutating the cache
		const srcPaths = this.#allPathsUnder(src);
		const snapshot = new Map<string, PathCacheEntry>();
		for (const p of srcPaths) {
			const e = this.#pathCache.get(p);
			if (e) snapshot.set(p, e);
		}

		// Remove src subtree and any existing dest subtree from cache
		for (const p of srcPaths) this.#pathCache.delete(p);
		const destPrefix = dest === "/" ? "/" : `${dest}/`;
		for (const key of [...this.#pathCache.keys()]) {
			if (key === dest || key.startsWith(destPrefix)) this.#pathCache.delete(key);
		}

		// Re-insert src entries under dest (remap prefix src → dest)
		for (const [oldPath, entry] of snapshot) {
			this.#pathCache.set(dest + oldPath.slice(src.length), entry);
		}
		this.#dirty = true;
	}

	resolvePath(base: string, path: string): string {
		if (path.startsWith("/")) return normalizeFsPath(path);
		const combined = base === "/" ? `/${path}` : `${base}/${path}`;
		return normalizeFsPath(combined);
	}

	async symlink(target: string, inputLinkPath: string): Promise<void> {
		const linkPath = validatePath(inputLinkPath);
		this.#assertWritable(linkPath, "symlink");
		// Note: target is intentionally not normalized - it's stored as-is
		if (target.includes("\0")) throw createEinval(target);
		if (!this.#allowSymlinks) throw createEperm(linkPath, "symlink");

		const { name, parentEntry } = this.#requireParentDir(linkPath);

		const mtime = new Date();

		const inodeId = await this.#withTx(async (tx) => {
			const id = await this.#dialect.createInode(tx, {
				sandboxId: this.#sandboxId,
				kind: INODE_KIND.SYMLINK,
				mode: 0o777,
				size: target.length,
				symlinkTarget: target,
			});
			await this.#dialect.insertDirent(tx, parentEntry.inodeId, name, id);
			return id;
		});

		this.#pathCache.set(linkPath, {
			inodeId,
			kind: INODE_KIND.SYMLINK,
			mode: 0o777,
			size: target.length,
			mtime,
			contentSha256: null,
			symlinkTarget: target,
		});
		this.#dirty = true;
	}

	async link(inputExistingPath: string, inputNewPath: string): Promise<void> {
		const existingPath = validatePath(inputExistingPath);
		const newPath = validatePath(inputNewPath);
		this.#assertWritable(newPath, "link");
		const srcEntry = this.#pathCache.get(existingPath);
		if (!srcEntry) throw createEnoent(existingPath);
		if (srcEntry.kind === INODE_KIND.DIRECTORY) throw createEperm(existingPath, "link");
		if (this.#pathCache.has(newPath)) throw createEexist(newPath);

		const { name: destName, parentEntry: destParentEntry } = this.#requireParentDir(newPath);

		await this.#withTx(async (tx) => {
			await this.#dialect.insertDirent(tx, destParentEntry.inodeId, destName, srcEntry.inodeId);
			await this.#dialect.incrementNlink(tx, srcEntry.inodeId);
		});

		this.#pathCache.set(newPath, { ...srcEntry });
		this.#dirty = true;
	}

	async readlink(inputPath: string): Promise<string> {
		const path = validatePath(inputPath);
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind !== INODE_KIND.SYMLINK) throw createEinval(path);
		return entry.symlinkTarget!;
	}

	async realpath(inputPath: string): Promise<string> {
		const path = validatePath(inputPath);
		// Read-only: skip the advisory lock.
		const resolvedInodeId = await this.#withReadTx(async (tx) => this.#dialect.resolvePath(tx, path, true));
		for (const [p, entry] of this.#pathCache) {
			if (entry.inodeId === resolvedInodeId) return p;
		}
		throw createEnoent(path);
	}
}
