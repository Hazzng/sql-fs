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

import { execContext } from "../api/exec-context.js";
import { readOnlyContext } from "../api/read-only-context.js";
import { runTrustedDbAsync } from "./defense.js";
import { raceDriverFault } from "./driver-fault.js";
import {
	createEexist,
	createEfbig,
	createEinval,
	createEisdir,
	createEnobufs,
	createEnoent,
	createEnotdir,
	createEnotempty,
	createEperm,
	createEreadonly,
	createEsandboxgone,
	createEstale,
} from "./errors.js";
import type { RedisBlobCache } from "./redis-blob-cache.js";
import { type RedisPathSnapshot, VERSION_TOMBSTONE, versionKey } from "./redis-path-snapshot.js";
import type { BufferedMutation, ScriptTxBufferConfig } from "./script-tx-buffer.js";
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

export const DEFAULT_CONTENT_CACHE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Flat per-mutation memory charge for the buffered script-tx cap (#166).
 *
 * A recorded op is a closure over a handful of scalars plus the path components it
 * captured; measured on the heaviest shapes in this file it sits well under this.
 * Call sites that capture something genuinely large (a subtree plan, a bulk-ingest
 * batch) pass their own estimate instead.
 */
const PER_MUTATION_BASE_BYTES = 200;

/** One mutation as handed to `SqlFs.#mutate` — see its doc for the contract on `run`. */
interface MutationSpec<Tx> {
	readonly kind: string;
	/** True for the composite CTEs, which carry their own set_config + advisory lock. */
	readonly composite: boolean;
	/** How many inode ids `run` creates. Defaults to none. */
	readonly mints?: number;
	/** Bytes the recorded closure keeps alive; defaults to `PER_MUTATION_BASE_BYTES`. */
	readonly bytes?: number;
	/**
	 * Method syntax, not a property: it makes the parameter bivariant, which keeps
	 * `SqlFs<PgTx>` assignable to `SqlFs<unknown>` the way it was before the journal
	 * existed (integration tests rely on that).
	 */
	run(tx: Tx): Promise<readonly (bigint | undefined)[]>;
}

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
	/**
	 * Buffered script-tx (#166). When enabled, mutations inside a script scope are
	 * recorded and replayed in one short transaction at `endScriptScope` instead of
	 * running on a transaction held open across the user's script.
	 *
	 * Defaults to DISABLED here so a bare `new SqlFs(...)` keeps the legacy shape;
	 * the deployment default (on) is applied by `createPostgresSandboxFs`, next to
	 * the other env reads.
	 */
	readonly scriptTxBuffer?: ScriptTxBufferConfig;
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
	 * True iff a recovery `reload()` failed after a transaction COMMIT/abort,
	 * leaving the in-memory caches holding mutations that never committed to the
	 * source of truth. While poisoned the caller MUST NOT publish a new version /
	 * snapshot — see `publishVersionIfDirty`. Cleared by a successful `reload()`.
	 */
	poisoned(): boolean;
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
	 * Set when a recovery `reload()` fails after a COMMIT/abort, so the in-memory
	 * caches still hold mutations that never landed in the source of truth.
	 * Read by `publishVersionIfDirty` to suppress publishing a version/snapshot
	 * of phantom state. Cleared on every successful `reload()`/`ready()`.
	 */
	#cachePoisoned = false;
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
	/** Durable sandbox epoch pinned while the writer lock is held for this scope. */
	#scriptEpoch: bigint | undefined;
	/** Epoch observed after the last completed write outside a script scope. */
	#lastKnownEpoch: bigint | undefined;
	/**
	 * Set when a scoped `#withWriteTx` ran. Those writes bump `version` via SQL
	 * without a JS round trip, so `#scriptEpoch` lags until `endScriptScope`
	 * re-reads it. A composite-only scope never sets this.
	 */
	#scriptEpochLagging = false;
	/**
	 * Set once the script-tx's connection is gone, and sticky for the rest of the scope.
	 *
	 * postgres.js keeps the scope's `sql` bound to one connection OBJECT, and the pool reconnects
	 * that same object for the next root-`sql` query — `commitBlob`, which every write issues first.
	 * A later write in the scope would therefore run on a live but transaction-LESS connection and
	 * self-commit outside the scope: measured as 599 of 600 files durable on a request that answered
	 * 500. Clearing `#scriptTx` alone is not enough, because the helpers below would simply reopen a
	 * fresh tx and `endScriptScope` would commit that one and report success. Once the connection is
	 * lost the only correct outcome is that every remaining operation in the scope fails.
	 *
	 * #166 reuses it for the buffered shape's two condemnations — a driver fault, and
	 * overflowing the mutation buffer — for the same reason: bash swallows a rejected
	 * fs call into a nonzero exit, so without a sticky verdict `endScriptScope` would
	 * flush whatever prefix the script had managed to record.
	 */
	#scriptTxLost: Error | undefined;
	/**
	 * Bumped on every open. The transaction callback assigns `#scriptTx` only while its own
	 * generation is still current: an abort that beats a queued `setSandboxContextWithLock` clears
	 * the scope, and the statement can still resolve afterwards. Assigning then would leave a
	 * rolled-back handle in place, and the NEXT scope would reuse it and skip opening a transaction
	 * of its own — committing into a transaction that no longer exists.
	 */
	#scriptTxGeneration = 0;
	#readOnlyDepth = 0;
	/**
	 * Buffered script-tx state (#166). `#mutations` is the ordered journal replayed
	 * by `#flushMutations`; `#idRemap` binds the provisional ids the script handed
	 * out to the ids the replay actually created.
	 *
	 * Provisional ids are negative and `inodes.id` is `BIGSERIAL`, so the two spaces
	 * cannot collide, and `#nextProvisionalId` keeps decreasing across scopes so an
	 * id left over from an aborted scope can never be mistaken for a fresh one.
	 * Nothing outside this class can observe one: `FsStat` carries no `ino` field,
	 * and the only consumer of `inodeId` outside `SqlFs` is the Redis path snapshot,
	 * which is published after `endScriptScope` has remapped them.
	 */
	readonly #scriptTxBuffer: ScriptTxBufferConfig;
	#mutations: BufferedMutation[] = [];
	#mutationBytes = 0;
	#idRemap = new Map<bigint, bigint>();
	#nextProvisionalId = -1n;
	/**
	 * Incremental byte estimate of `#pathCache`, maintained O(1) on every
	 * set/delete/clear (F9e). Equals the old full-walk
	 * `Σ (path.length + 100)` exactly, so callers can size the path-cache
	 * memory budget without re-walking the whole Map on every dirty exec.
	 */
	#pathCacheBytes = 0;

	constructor(opts: SqlFsOptions<Tx>) {
		this.#dialect = opts.dialect;
		this.#sandboxId = opts.sandboxId;
		this.#tenantId = opts.tenantId ?? "default";
		this.#allowSymlinks = opts.allowSymlinks ?? false;
		this.#redis = opts.redis;
		this.#pathSnapshot = opts.pathSnapshot;
		this.#blobCache = opts.blobCache;
		this.#scriptTxBuffer = opts.scriptTxBuffer ?? { enabled: false, maxOps: 0, maxBytes: 0 };
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

	/** @internal exposed for tests asserting contentCache eviction (F9a). */
	_getContentCache(): LRUCache<bigint, Uint8Array> {
		return this.#contentCache;
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

	poisoned(): boolean {
		return this.#cachePoisoned;
	}

	// ── Transaction helper ────────────────────────────────────────────────────────

	/**
	 * Every await on the driver goes through here.
	 *
	 * `runTrustedDbAsync` exits just-bash's defense-in-depth scope; `raceDriverFault` fails the call
	 * if postgres.js throws out of its own socket-write path while it is in flight (#169). The driver
	 * throws there INSTEAD of rejecting the query it was writing, so without the race the promise
	 * never settles and the request hangs until the client gives up — the crash guard alone just
	 * trades a loud failure for a silent one.
	 *
	 * Inside a script scope the verdict is sticky: the scope's transaction is on a connection that is
	 * at best suspect, so the rest of the script must fail closed rather than reopen a fresh
	 * transaction and commit half a script (the same reasoning as `#scriptTxLost`).
	 */
	async #db<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await raceDriverFault(() => runTrustedDbAsync(fn));
		} catch (err) {
			if (this.#scriptScope && (err as Error & { code?: string }).code === "EDRIVERFAULT") {
				this.#scriptTxLost ??= err as Error;
			}
			throw err;
		}
	}

	async #withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		if (this.#scriptScope) {
			this.#assertScriptTxAlive();
			if (this.#scriptTx === undefined) {
				await this.#openScriptTx();
			}
			const tx = this.#scriptTx as Tx;
			return this.#db(() => fn(tx));
		}
		return this.#db(() =>
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
		this.#assertScriptTxAlive();
		const scriptTx = this.#scriptTx;
		if (this.#scriptScope && scriptTx !== undefined) {
			return this.#db(() => fn(scriptTx));
		}
		return this.#db(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContext(tx, this.#sandboxId);
				return await fn(tx);
			}),
		);
	}

	/**
	 * Refuse further work in a scope whose transaction is gone. See `#scriptTxLost`.
	 *
	 * The scope check lives here rather than at each call site: a reader that forgets it would
	 * serve mutations that are about to be rolled back.
	 */
	#assertScriptTxAlive(): void {
		if (this.#scriptScope && this.#scriptTxLost !== undefined) throw this.#scriptTxLost;
	}

	async #openScriptTx(): Promise<void> {
		// #166: under the buffered shape no transaction may span the script. Reaching
		// here means a write escaped `#mutate` — loud is the only safe failure, because
		// the silent version is the very connection pin this change exists to remove.
		if (this.#scriptTxBuffer.enabled) {
			throw new Error("script-tx: a mutation bypassed the buffer while SCRIPT_TX_BUFFERED is on");
		}
		const generation = ++this.#scriptTxGeneration;
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
		// `#scriptTxAbort` is live from here, but the only `await endPromise` sits inside the
		// transaction callback below and is not reached until `setSandboxContextWithLock` resolves.
		// An abort in between — an exec timing out while the statement is queued — would otherwise
		// reject a promise nobody is listening to and kill the process under the default
		// `--unhandled-rejections=throw`. Behind a connection pooler that queue is seconds to
		// minutes wide, so the window is routine rather than theoretical. The derived chain absorbs
		// the rejection without clearing it: the `await` below still throws and still rolls back.
		endPromise.catch(() => {});
		this.#scriptTxEnd = resolveEnd;
		this.#scriptTxAbort = rejectEnd;

		const scriptTxPromise = runTrustedDbAsync(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				// The scope may have aborted while this statement was queued; adopting `tx` now would
				// hand the next scope a rolled-back handle.
				if (generation !== this.#scriptTxGeneration || !this.#scriptScope) {
					throw new Error("script-tx abandoned: scope ended while the transaction was opening");
				}
				// Pin + compare inside the locked tx; a separate pre-read would TOCTOU.
				const epoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				if (this.#lastKnownEpoch !== undefined && epoch !== this.#lastKnownEpoch) {
					throw createEstale(this.#sandboxId);
				}
				this.#scriptEpoch = epoch;
				this.#scriptTx = tx;
				resolveTxReady();
				await endPromise;
			}),
		);
		this.#scriptTxPromise = scriptTxPromise;
		// Consumes the rejection so a lost connection cannot surface as an unhandled rejection, and
		// records it so the rest of the scope fails closed (see `#scriptTxLost`). `endScriptScope`
		// still sees the rejection via `await this.#scriptTxPromise`, because .catch() creates a new
		// derived chain without clearing the original's rejected state. `#scriptTx` is deliberately
		// left set: `endScriptScope`'s recovery keys off `hadTx` to reload the cache off the rolled-
		// back state, and that reload is still needed.
		scriptTxPromise.catch((err: unknown) => {
			this.#scriptTxLost ??= err instanceof Error ? err : new Error("script-tx connection lost");
		});

		// Race txReady against #scriptTxPromise so that a connection failure before
		// setSandboxContextWithLock completes (i.e. before resolveTxReady fires) propagates
		// immediately rather than leaving this call hanging forever. The driver fault (#169) is a
		// third way for BOTH arms to stay pending forever: postgres.js throws out of its socket
		// write instead of rejecting the query, so `setSandboxContextWithLock` never settles.
		// `scriptTxPromise` itself is deliberately NOT raced — it lives for the whole scope and
		// `endScriptScope` needs the real COMMIT verdict off it.
		try {
			await raceDriverFault(() => Promise.race([txReady, scriptTxPromise]));
		} catch (err) {
			// The transaction callback may still be parked with nobody to end it. Nothing in this
			// scope may reopen on that connection, so the loss is sticky exactly as for a rejection.
			if ((err as Error & { code?: string }).code === "EDRIVERFAULT") this.#scriptTxLost ??= err as Error;
			throw err;
		}
	}

	#expectedEpochArgs(): [bigint] | [] {
		return this.#scriptEpoch === undefined ? [] : [this.#scriptEpoch];
	}

	/** Records the live epoch for freshly installed cache state (F2-L2). */
	async #refreshKnownEpoch(): Promise<void> {
		// #169 M4: `#db` rather than a bare `runTrustedDbAsync` — unraced, a driver fault leaves
		// this await pending for the life of the session.
		this.#lastKnownEpoch = await this.#db(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContext(tx, this.#sandboxId);
				return await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
			}),
		);
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
			this.#assertScriptTxAlive();
			if (this.#scriptTx === undefined) {
				await this.#openScriptTx();
			}
			const scriptTx = this.#scriptTx as Tx;
			const value = await this.#db(() => fn(scriptTx));
			// Refresh tx-local epoch; composites advance version (mv twice).
			if (this.#scriptEpoch !== undefined) {
				this.#scriptEpoch = await this.#db(() => this.#dialect.getSandboxEpoch(scriptTx, this.#sandboxId));
			}
			return value;
		}
		// No active scope — use a fresh, self-committing transaction (original
		// behavior, no extra round-trip for the mutation itself).
		let observedEpoch: bigint | undefined;
		const result = await this.#db(() =>
			this.#dialect.transaction(async (tx) => {
				const value = await fn(tx);
				// Publish only after COMMIT; a failed COMMIT must not poison the cache.
				observedEpoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				return value;
			}),
		);
		if (observedEpoch !== undefined) this.#lastKnownEpoch = observedEpoch;
		return result;
	}

	/**
	 * Transaction helper for mutations that are not one composite CTE.
	 * Outside a scope, re-reads the epoch after the write so the next scope
	 * does not ESTALE itself. Inside a scope the pin is allowed to lag until
	 * `#settleLaggingScriptEpoch`.
	 */
	async #withWriteTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		if (this.#scriptScope) {
			const value = await this.#withTx(fn);
			this.#scriptEpochLagging = true;
			return value;
		}
		let observedEpoch: bigint | undefined;
		const result = await this.#db(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				const value = await fn(tx);
				// Publish only after COMMIT; a failed COMMIT must not poison the pin.
				observedEpoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				return value;
			}),
		);
		if (observedEpoch !== undefined) this.#lastKnownEpoch = observedEpoch;
		return result;
	}

	// ── Buffered script-tx (#166) ─────────────────────────────────────────────────

	/** True while mutations must be recorded rather than issued. */
	#bufferingWrites(): boolean {
		return this.#scriptTxBuffer.enabled && this.#scriptScope;
	}

	/**
	 * Hands out an inode id the database has not created yet. Negative, so it can
	 * never collide with a `BIGSERIAL` id, and monotonically decreasing for the life
	 * of the session so a stale id from an aborted scope is never reused.
	 */
	#mintInodeId(): bigint {
		const id = this.#nextProvisionalId;
		this.#nextProvisionalId -= 1n;
		return id;
	}

	/**
	 * Substitutes the real id for a provisional one. Called from inside a replay
	 * closure, where every earlier op in the journal has already been bound.
	 *
	 * Real ids pass through, so call sites can use it unconditionally: an eager
	 * write never sees a provisional id and pays only the sign test.
	 */
	#realId(id: bigint): bigint {
		if (id >= 0n) return id;
		const real = this.#idRemap.get(id);
		if (real === undefined) {
			throw Object.assign(new Error(`script-tx flush: provisional inode id ${id} was never bound`), {
				code: "ECOHERENCE",
			});
		}
		return real;
	}

	/**
	 * The one gate every metadata mutation goes through.
	 *
	 * Outside a buffered scope `run` executes immediately — `composite` picks between
	 * the composites' self-contained preamble (`#withBareTx`) and the
	 * `setSandboxContextWithLock` one (`#withWriteTx`) — and returns the ids the
	 * database generated, exactly as before.
	 *
	 * Inside one it is RECORDED: the caller gets `mints` provisional ids back with no
	 * DB round trip, and `run` is replayed verbatim at flush. This is what removes the
	 * script-long transaction: between `beginScriptScope` and `endScriptScope` the
	 * write path issues no SQL at all beyond the eager, self-committing `commitBlob`.
	 *
	 * `run` must not read `#pathCache` — it runs after the cache has already been
	 * mutated by its own call. Capture what it needs before returning it.
	 */
	async #mutate(op: MutationSpec<Tx>): Promise<readonly bigint[]> {
		const mints = op.mints ?? 0;
		if (this.#bufferingWrites()) {
			this.#assertScriptTxAlive();
			const minted: bigint[] = [];
			for (let i = 0; i < mints; i++) minted.push(this.#mintInodeId());
			this.#recordMutation({ kind: op.kind, minted, bytes: op.bytes ?? PER_MUTATION_BASE_BYTES, run: op.run });
			return minted;
		}
		const produced = op.composite ? await this.#withBareTx(op.run) : await this.#withWriteTx(op.run);
		// The `undefined` slot exists only for the buffered replay, where a path the
		// database produced no row for must be caught by the provisional sweep. Running
		// eagerly the dialect contract is "return the id or throw", so the value passes
		// through exactly as it did before this gate existed.
		return produced as readonly bigint[];
	}

	/**
	 * `#mutate` for the ten call sites that create exactly one inode.
	 *
	 * The cast mirrors `#mutate`'s: a dialect that returns no id where the interface
	 * says it must is a broken dialect, and pre-#166 those call sites propagated the
	 * same `undefined` into the cache rather than throwing.
	 */
	async #mutateOne(op: Omit<MutationSpec<Tx>, "mints">): Promise<bigint> {
		const produced = await this.#mutate({ ...op, mints: 1 });
		return produced[0] as bigint;
	}

	/**
	 * Appends to the journal, failing the whole scope at the cap.
	 *
	 * Fail closed, not flush-and-continue: a mid-script flush silently turns one
	 * commit into two, and `ELOCKLOST`'s documented "nothing was committed" claim —
	 * plus #170's verified rollback behaviour — rest on per-script all-or-nothing.
	 * Condemning the scope via `#scriptTxLost` matters as much as throwing: bash
	 * swallows a rejected fs call into a nonzero exit and keeps going, so without it
	 * `endScriptScope` would happily flush the truncated prefix.
	 */
	#recordMutation(m: BufferedMutation): void {
		const ops = this.#mutations.length + 1;
		const bytes = this.#mutationBytes + m.bytes;
		if (ops > this.#scriptTxBuffer.maxOps || bytes > this.#scriptTxBuffer.maxBytes) {
			const err = createEnobufs(ops, bytes, this.#scriptTxBuffer.maxOps, this.#scriptTxBuffer.maxBytes);
			this.#scriptTxLost ??= err;
			throw err;
		}
		this.#mutations.push(m);
		this.#mutationBytes = bytes;
	}

	/** Drops the journal. Called from both scope exits; the caches are fixed by the caller. */
	#discardMutations(): void {
		this.#mutations = [];
		this.#mutationBytes = 0;
		this.#idRemap.clear();
	}

	/**
	 * Replays the journal in ONE short transaction and commits — the whole point of
	 * #166. The pinned-connection window is now this call, not the user's script.
	 *
	 * The epoch is pinned and compared inside the locked transaction exactly as
	 * `#openScriptTx` did, so a cross-replica write that landed while the script ran
	 * is still caught: `version` has moved past the epoch this session's caches were
	 * built on, and the whole script is rolled back rather than overwriting it. The
	 * difference from the legacy shape is only WHEN that is detected — the advisory
	 * lock no longer keeps the other replica out for the script's duration, so an
	 * overlap that used to queue now surfaces as ESTALE.
	 *
	 * The pin is not refreshed per op. Every replayed statement advances `version`
	 * off the transaction-local `app.sandbox_epoch` GUC, and the fence's
	 * `version > expectedEpoch AND version = GUC` branch admits exactly that lag
	 * (#192), so one re-read before COMMIT is enough — and it keeps the flush at one
	 * round trip per mutation instead of two.
	 */
	async #flushMutations(): Promise<void> {
		const ops = this.#mutations;
		if (ops.length === 0) return;
		const startedAt = Date.now();
		const finalEpoch = await this.#db(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
				const epoch = await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
				if (this.#lastKnownEpoch !== undefined && epoch !== this.#lastKnownEpoch) {
					throw createEstale(this.#sandboxId);
				}
				this.#scriptEpoch = epoch;
				for (const op of ops) {
					const produced = await (op.run as (handle: Tx) => Promise<readonly (bigint | undefined)[]>)(tx);
					for (let i = 0; i < op.minted.length; i++) {
						const real = produced[i];
						if (real !== undefined) this.#idRemap.set(op.minted[i]!, real);
					}
				}
				return await this.#dialect.getSandboxEpoch(tx, this.#sandboxId);
			}),
		);
		this.#scriptEpoch = finalEpoch;
		console.log(
			JSON.stringify({
				event: "script_tx_flush",
				sandboxId: this.#sandboxId,
				ops: ops.length,
				bufferedBytes: this.#mutationBytes,
				durationMs: Date.now() - startedAt,
			}),
		);
		this.#applyIdRemap();
	}

	/**
	 * Rewrites the provisional ids the script handed out to the ones the flush
	 * created. Runs after COMMIT, before any version/snapshot publish.
	 *
	 * The trailing sweep is the fail-closed half: a provisional id still in the
	 * pathCache means the replay produced no row for a path the cache claims exists —
	 * cache/DB divergence — and letting it stand would key a contentCache entry no
	 * inode owns and publish a negative id into the Redis path snapshot. Throwing
	 * here lands in `endScriptScope`'s catch, which reloads the committed state.
	 */
	#applyIdRemap(): void {
		if (this.#idRemap.size > 0) {
			for (const [path, entry] of this.#pathCache) {
				const real = this.#idRemap.get(entry.inodeId);
				if (real !== undefined) this.#cacheSet(path, { ...entry, inodeId: real });
			}
			for (const [provisional, real] of this.#idRemap) {
				const bytes = this.#contentCache.get(provisional);
				this.#contentCache.delete(provisional);
				if (bytes !== undefined) this.#contentCache.set(real, bytes);
			}
			this.#idRemap.clear();
		}
		const unbound: string[] = [];
		for (const [path, entry] of this.#pathCache) {
			if (entry.inodeId < 0n) unbound.push(path);
		}
		if (unbound.length > 0) {
			throw Object.assign(
				new Error(
					`ECOHERENCE: script-tx flush left ${unbound.length} path(s) on provisional inode ids: ${unbound.slice(0, 5).join(", ")}`,
				),
				{ code: "ECOHERENCE" },
			);
		}
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
			if (e.inodeId === inodeId) this.#cacheSet(p, { ...e, ...patch });
		}
	}

	// ── pathCache mutation helpers (F9e: O(1) byte accounting) ──────────────────
	//
	// Every mutation of `#pathCache` MUST go through these so `#pathCacheBytes`
	// stays in lockstep. The byte estimate depends only on the SET of keys
	// (`Σ key.length + 100`), so a `set` on an existing key is a no-op for the
	// counter — matching `#updateCacheByInode`'s in-place value patches.

	/** Sets a pathCache entry, adjusting the byte counter only when the key is new. */
	#cacheSet(key: string, entry: PathCacheEntry): void {
		if (!this.#pathCache.has(key)) {
			this.#pathCacheBytes += key.length + 100;
		}
		this.#pathCache.set(key, entry);
	}

	/** Deletes a pathCache entry, subtracting its byte contribution if present. */
	#cacheDelete(key: string): void {
		if (this.#pathCache.delete(key)) {
			this.#pathCacheBytes -= key.length + 100;
		}
	}

	/** Clears the pathCache and resets the byte counter. */
	#cacheClear(): void {
		this.#pathCache.clear();
		this.#pathCacheBytes = 0;
	}

	/**
	 * O(1) byte estimate of the pathCache, equal to the old full-walk
	 * `Σ (path.length + 100)`. Consumed by SessionManager's path-cache memory
	 * budget so it never re-walks the whole Map on a dirty exec (F9e).
	 */
	getPathCacheBytes(): number {
		return this.#pathCacheBytes;
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
				// F7: a tombstone must never be coerced to 0 by `Number(raw) || 0`
				// and then falsely match a `version: 0` snapshot. Treat it as a hard
				// mismatch (`-1`, an impossible snapshot version) so we fall through
				// to `loadAllPaths`, which throws ESANDBOXGONE for the (now absent)
				// sandbox.
				const currentVersion = raw === VERSION_TOMBSTONE ? -1 : raw === null ? 0 : Number(raw) || 0;
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
		// #169 M4: routed through `#db` like every other driver await — a bare `dialect.transaction`
		// here is neither raced (a fault leaves the reload pending forever) nor inside the
		// defense-in-depth escape hatch.
		const rows = await this.#db(() =>
			this.#dialect.transaction(async (tx) => {
				await this.#dialect.setSandboxContext(tx, this.#sandboxId);
				return await this.#dialect.loadAllPaths(tx);
			}),
		);
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
				// Raced but NOT routed through `#db`: prewarm is a background cache warm, not part of any
				// request, so a driver fault must bound its wait without condemning a script scope that
				// happens to be open at the time. Its failure is swallowed below either way.
				const blobs = await raceDriverFault(() =>
					runTrustedDbAsync(() => this.#dialect.getBlobsForSandbox(this.#sandboxId, cap)),
				);
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
		this.#cacheClear();
		for (const [p, e] of entries) this.#cacheSet(p, e);
		// Initial load established committed state; the cache is not poisoned (F1).
		this.#cachePoisoned = false;
		// Baseline the fence token for the state just installed; without this a
		// later scope cannot tell a cross-replica write from its own (F2-L2).
		await this.#refreshKnownEpoch();

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
		// Defense-in-depth (F4): never reload while a script scope is open. A
		// concurrent reload (e.g. a same-replica reader's `ensureFreshCache` on a
		// Redis blip or version bump) would clear `#pathCache` / `#dirty` out from
		// under an open writer mid-script — destroying its uncommitted in-memory
		// view and suppressing its version publish. `endScriptScope` /
		// `abortScriptScope` clear `#scriptScope` BEFORE their own reload(), so
		// this guard does not block the legitimate commit/abort refresh paths.
		if (this.#scriptScope) {
			return;
		}
		if (this.#pendingReload !== undefined) {
			return this.#pendingReload;
		}
		const p = (async (): Promise<void> => {
			try {
				const { entries } = await this.#loadFreshPathCache();
				// F7: a cross-replica reload that comes back EMPTY means the sandbox
				// was destroyed on another replica — the recursive CTE anchor joins
				// `sandboxes` → root `inode`, so a live sandbox always yields at least
				// its root dir. Refuse to install an empty pathCache (which would
				// serve ghost ENOENTs and break cwd resolution inside bash.exec).
				// Throw ESANDBOXGONE WITHOUT clearing the existing caches so the
				// session manager can tear the stale warm session down and surface a
				// clean ENOENT → 404. (This guard lives in reload(), not ready():
				// ready() runs immediately after createSandbox, which guarantees a
				// root row, whereas reload() refreshes a long-lived warm session.)
				if (entries.size === 0) {
					throw createEsandboxgone(this.#sandboxId);
				}
				this.#cacheClear();
				for (const [path, entry] of entries) this.#cacheSet(path, entry);
				this.#contentCache.clear();
				this.#dirty = false;
				// A successful reload re-established committed state in the caches,
				// so any prior poison is resolved (F1).
				this.#cachePoisoned = false;
				await this.#refreshKnownEpoch();
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
		this.#scriptTxLost = undefined;
		this.#scriptEpochLagging = false;
		this.#discardMutations();
		// Any open still in flight from a previous scope belongs to an older generation and will
		// abandon itself rather than adopt into this one.
		this.#scriptTxGeneration += 1;
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

	/**
	 * #168: bound the file size a *bash script* may read whole or produce.
	 *
	 * Only script-issued calls are bounded — `execContext` is set around `bash.exec`
	 * only — because the cost being bounded is just-bash's synchronous string
	 * rebuilding, not the bytes themselves. The HTTP/MCP routes reach the same
	 * methods and keep their own (much looser) caps; capping them here would make a
	 * 50 MiB `PUT` illegal to read back, and would leak one exec's ceiling onto a
	 * `GET` running concurrently under the same shared session lock.
	 *
	 * Checked against the *declared* size before the blob is fetched or the
	 * concatenation is built, so tripping the cap costs neither the round trip nor
	 * the allocation the cap exists to prevent.
	 */
	#assertExecFileSize(path: string, bytes: number, op: "read" | "write"): void {
		const ctx = execContext.getStore();
		if (ctx === undefined || bytes <= ctx.maxFileBytes) return;
		const err = createEfbig(path, bytes, ctx.maxFileBytes, op);
		// Recorded as well as thrown: bash swallows a read rejection into a phantom
		// "No such file or directory". See ExecContext.exceeded.
		if (ctx.exceeded === undefined) ctx.exceeded = err;
		throw err;
	}

	#assertWritable(path: string, op: string): void {
		if (this.#readOnlyDepth > 0) {
			const ctx = readOnlyContext.getStore();
			if (ctx !== undefined) ctx.violated = true;
			throw createEreadonly(path, op);
		}
	}

	/**
	 * Re-read the pin once before COMMIT when a non-composite write may have
	 * moved `version`. A failed read must abort the scope: a SQL error aborts
	 * the Postgres transaction, and swallowing it would let `#scriptTxEnd`
	 * COMMIT (or appear to) while the caches still hold this script's writes.
	 */
	async #settleLaggingScriptEpoch(): Promise<void> {
		const scriptTx = this.#scriptTx;
		if (!this.#scriptEpochLagging || scriptTx === undefined || this.#scriptEpoch === undefined) return;
		this.#scriptEpochLagging = false;
		this.#scriptEpoch = await this.#db(() => this.#dialect.getSandboxEpoch(scriptTx, this.#sandboxId));
	}

	async endScriptScope(): Promise<void> {
		if (!this.#scriptScope) return;

		// #169 M3: never COMMIT a condemned scope. After a driver fault every later fs op throws
		// via `#assertScriptTxAlive`, but bash swallows those into a nonzero exit rather than
		// rejecting, so control still arrives here — and `#scriptTxEnd()` would commit whatever
		// part of the script did land and report success. Delegate to the single abort path
		// (reject endPromise → ROLLBACK → reload) and surface the fault.
		const lost = this.#scriptTxLost;
		if (lost !== undefined) {
			await this.abortScriptScope();
			throw lost;
		}

		this.#scriptScope = false;

		// A buffered scope has no transaction, but its caches still hold mutations that
		// are not in the database — so the recovery reload below is keyed off either.
		const hadTx = this.#scriptTx !== undefined || this.#mutations.length > 0;
		let committed = false;
		try {
			await this.#flushMutations();
			await this.#settleLaggingScriptEpoch();
			if (this.#scriptTxEnd !== undefined) {
				this.#scriptTxEnd();
				// The COMMIT is the last driver await of the scope and hangs the same way on a
				// driver fault (#169), so it races too — a request that cannot learn whether it
				// committed must at least be told that, not left open until the client times out.
				const txPromise = this.#scriptTxPromise;
				if (txPromise !== undefined) await raceDriverFault(() => txPromise);
			}
			committed = true;
		} catch (err) {
			// Settlement or COMMIT failed. If we never resolved `#scriptTxEnd`, the
			// transaction callback is still parked — abort it so the dialect issues
			// ROLLBACK. A failed COMMIT already rolled back; abort is then a no-op
			// on the already-settled endPromise. Reload discards phantom cache
			// entries (audit H7) either way.
			if (hadTx) {
				if (!committed) {
					const abort = this.#scriptTxAbort;
					const txPromise = this.#scriptTxPromise;
					if (abort !== undefined) {
						abort(err instanceof Error ? err : new Error("script-tx aborted"));
					}
					if (txPromise !== undefined) {
						try {
							await txPromise;
						} catch {
							// rollback of the parked callback, or the COMMIT that already failed
						}
					}
				}
				try {
					await this.reload();
					this.clearDirty();
				} catch {
					this.#cachePoisoned = true;
				}
			}
			throw err;
		} finally {
			if (committed && this.#scriptEpoch !== undefined) this.#lastKnownEpoch = this.#scriptEpoch;
			this.#scriptTx = undefined;
			this.#scriptTxEnd = undefined;
			this.#scriptTxAbort = undefined;
			this.#scriptTxPromise = undefined;
			this.#scriptEpoch = undefined;
			this.#scriptEpochLagging = false;
			this.#discardMutations();
		}
	}

	async abortScriptScope(): Promise<void> {
		if (!this.#scriptScope) return;
		this.#scriptScope = false;

		// Buffered mutations never reached the database, so the abort itself is free —
		// but the caches hold them, so the reload below is still required.
		const hadTx = this.#scriptTx !== undefined || this.#mutations.length > 0;
		this.#discardMutations();
		const abort = this.#scriptTxAbort;
		const txPromise = this.#scriptTxPromise;
		this.#scriptTx = undefined;
		this.#scriptTxEnd = undefined;
		this.#scriptTxAbort = undefined;
		this.#scriptTxPromise = undefined;
		this.#scriptEpoch = undefined;
		this.#scriptEpochLagging = false;

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
				// Reload also failed (correlated PG outage): the caches still hold
				// uncommitted mutations. Mark poisoned so publishVersionIfDirty
				// refuses to publish phantom state (F1). The next ensureFreshCache
				// probe reloads the cache.
				this.#cachePoisoned = true;
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
		// #166: deliberately NOT buffered, and unreachable inside a scope today — both
		// call sites (`POST /ingest/files`, MCP `ingest_files`) go straight at the
		// session, never through `runInScriptTx`. Buffering it would mean predicting the
		// dialect's DB-derived ancestor resolution in JS and holding every ingested byte
		// in the journal, which is the one memory cost this design exists to avoid. It is
		// also already one short transaction of its own, so it is not a #166 exposure.
		// If it is ever composed into a scope, fail loudly rather than silently splitting
		// the script into two commits.
		if (this.#bufferingWrites()) {
			throw Object.assign(
				new Error("bulkIngest: not supported inside a buffered script scope — call it outside exec"),
				{ code: "ENOTSUP" },
			);
		}
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
		const newEntries = await this.#withWriteTx((tx) =>
			this.#dialect.bulkIngest(tx, normalized, this.#sandboxId, ...this.#expectedEpochArgs()),
		);
		// Evict overwritten inodes from contentCache so stale content is never served.
		// Populate #contentCache with the bytes already in memory — next readFile is a Map lookup.
		for (const [path, entry] of newEntries) {
			const old = this.#pathCache.get(path);
			if (old !== undefined && old.inodeId !== entry.inodeId) {
				this.#contentCache.delete(old.inodeId);
			}
			this.#cacheSet(path, entry);
			const bytes = bytesByPath.get(path);
			if (bytes !== undefined && bytes.byteLength > 0) {
				this.#contentCache.set(entry.inodeId, bytes);
			}
		}
		this.#dirty = true;
	}

	// ── IFileSystem: cache-served methods ────────────────────────────────────────

	getAllPaths(): string[] {
		this.#assertScriptTxAlive();
		return [...this.#pathCache.keys()];
	}

	/**
	 * Bytes to hand the write path for its blob-cache backfill, or `undefined` when
	 * `commitBlob` already did it on its own connection — which it always has on the
	 * only dialect that has composites. Returning `undefined` is what keeps file bytes
	 * out of the mutation journal.
	 */
	#blobArgFor(bytes: Uint8Array): Uint8Array | undefined {
		return this.#bufferingWrites() && this.#dialect.commitBlob !== undefined ? undefined : bytes;
	}

	/**
	 * The inode/dirent half of `writeFile` and `appendFile`, built in its own scope.
	 *
	 * The scope matters as much as the sharing: a closure created inside `writeFile`
	 * would sit in a context object holding every variable any sibling closure there
	 * captures — the file's bytes included — and a journal entry that lives for the
	 * whole script would keep them alive. Here it captures these six values and
	 * nothing else. `blobBytes` is undefined exactly when the caller already
	 * committed and backfilled the blob.
	 */
	#putFileOp(
		kind: "writeFile" | "appendFile",
		parentInodeId: bigint,
		name: string,
		size: number,
		sha256: Uint8Array,
		blobBytes: Uint8Array | undefined,
	): Omit<MutationSpec<Tx>, "mints"> {
		if (this.#dialect.writeFileComposite) {
			return {
				kind,
				composite: true,
				run: async (tx) => [
					await this.#dialect.writeFileComposite!(
						tx,
						this.#sandboxId,
						this.#realId(parentInodeId),
						name,
						0o644,
						size,
						sha256,
						blobBytes,
						...this.#expectedEpochArgs(),
					),
				],
			};
		}
		return {
			kind,
			composite: false,
			// Only reachable on a dialect without `commitBlob`, where `blobBytes` is the
			// content and the journal must carry it because the insert is part of the replay.
			bytes: PER_MUTATION_BASE_BYTES + (blobBytes?.byteLength ?? 0),
			run: async (tx) => {
				if (!this.#dialect.commitBlob) await this.#dialect.upsertBlob(tx, sha256, blobBytes!);
				const id = await this.#dialect.createInode(
					tx,
					{ sandboxId: this.#sandboxId, kind: INODE_KIND.FILE, mode: 0o644, size, contentSha256: sha256 },
					...this.#expectedEpochArgs(),
				);
				const oldInodeId = await this.#dialect.upsertDirent(tx, this.#realId(parentInodeId), name, id);
				if (oldInodeId !== null) {
					const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
					if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
				}
				return [id];
			},
		};
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
		this.#assertExecFileSize(path, bytes.byteLength, "write");
		const sha256 = new Uint8Array(createHash("sha256").update(bytes).digest());
		const mtime = new Date();

		// F6: commit the CAS blob in its own short tx FIRST, so the composite
		// (which runs on the long-lived script-tx) no longer holds the hot-blob
		// tuple lock for the script duration.
		//
		// #169 M4: this is a root-`sql` statement and it runs BEFORE `#withBareTx` reaches
		// `#assertScriptTxAlive`, so a condemned scope would still put it on the wire — the exact
		// hazard `#scriptTxLost` exists to prevent. Assert first, and route it through `#db` so a
		// fault during the blob write is raced (it never settles on its own) and condemns the scope.
		this.#assertScriptTxAlive();
		if (this.#dialect.commitBlob) await this.#db(() => this.#dialect.commitBlob!(sha256, bytes));

		const inodeId = await this.#mutateOne(
			this.#putFileOp("writeFile", parentEntry.inodeId, name, bytes.length, sha256, this.#blobArgFor(bytes)),
		);

		// Evict the displaced inode's bytes from contentCache so the dead entry
		// (ids are never reused) is not left as orphaned LRU weight. This must run
		// before the `set` below, and crucially also when overwriting with an empty
		// file — where there is no overwriting `set` to displace the old entry.
		const displaced = this.#pathCache.get(path);
		if (displaced !== undefined && displaced.inodeId !== inodeId) {
			this.#contentCache.delete(displaced.inodeId);
		}
		this.#cacheSet(path, {
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
		// The resulting size, not the appended chunk: `appendFile` materializes base+chunk in
		// one buffer, and a file grown past the cap by repeated appends would then be unreadable
		// from the same script. Checked off the cached size so the base blob is never fetched.
		const appendedTotal = (existing?.kind === INODE_KIND.FILE ? existing.size : 0) + bytes.byteLength;
		this.#assertExecFileSize(path, appendedTotal, "write");
		let fullBytes: Uint8Array;

		if (existing && existing.kind === INODE_KIND.FILE && existing.contentSha256 !== null) {
			// Buffered: there is no script-tx to read consistently with, and there are no
			// in-flight inode mutations to be consistent WITH — the blob is content-addressed
			// and already committed — so take the lock-free read transaction instead of
			// opening a writer transaction that would span the rest of the script.
			const readInTx = this.#bufferingWrites()
				? <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => this.#withReadTx(fn)
				: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => this.#withTx(fn);
			const oldContent = await readInTx(async (tx) => this.#dialect.getBlob(tx, existing.contentSha256!));
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

		// F6: commit the CAS blob in its own short tx FIRST (see writeFile), under the same
		// liveness assert and the same driver-fault race (#169 M4).
		this.#assertScriptTxAlive();
		if (this.#dialect.commitBlob) await this.#db(() => this.#dialect.commitBlob!(sha256, fullBytes));

		const inodeId = await this.#mutateOne(
			this.#putFileOp("appendFile", parentEntry.inodeId, name, fullBytes.length, sha256, this.#blobArgFor(fullBytes)),
		);

		if (existing) this.#contentCache.delete(existing.inodeId);
		if (fullBytes.byteLength > 0) this.#contentCache.set(inodeId, fullBytes);
		this.#cacheSet(path, {
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
					// One fence and one bump per segment actually created: outside a
					// scope each segment is its own transaction anyway, and batching
					// them would change `mkdir -p`'s partial-failure behaviour. A
					// `mkdir -p` over an existing tree creates nothing and costs nothing.
					const inodeId = await this.#mutateOne({
						kind: "mkdir -p",
						composite: false,
						run: async (tx) => {
							const id = await this.#dialect.createInode(
								tx,
								{
									sandboxId: this.#sandboxId,
									kind: INODE_KIND.DIRECTORY,
									mode: 0o755,
									size: 0,
								},
								...this.#expectedEpochArgs(),
							);
							await this.#dialect.insertDirent(tx, this.#realId(parentEntry.inodeId), seg, id);
							return [id];
						},
					});
					this.#cacheSet(next, {
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

		const inodeId = await this.#mutateOne(
			this.#dialect.mkdirComposite
				? {
						kind: "mkdir",
						composite: true,
						run: async (tx) => [
							await this.#dialect.mkdirComposite!(
								tx,
								this.#sandboxId,
								this.#realId(parentEntry.inodeId),
								name,
								0o755,
								...this.#expectedEpochArgs(),
							),
						],
					}
				: {
						kind: "mkdir",
						composite: false,
						run: async (tx) => {
							const id = await this.#dialect.createInode(
								tx,
								{
									sandboxId: this.#sandboxId,
									kind: INODE_KIND.DIRECTORY,
									mode: 0o755,
									size: 0,
								},
								...this.#expectedEpochArgs(),
							);
							await this.#dialect.insertDirent(tx, this.#realId(parentEntry.inodeId), name, id);
							return [id];
						},
					},
		);

		this.#cacheSet(path, {
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

			// The plan is resolved from the pathCache HERE, not inside the replay: a
			// buffered op runs after its own cache updates have already landed, so
			// reading the cache from the closure would walk an already-emptied subtree.
			const plan = subtreePaths.map((p) => {
				const e = this.#pathCache.get(p)!;
				const parent = p === path ? undefined : this.#pathCache.get(this.#parentOf(p));
				return { inodeId: e.inodeId, parentInodeId: parent?.inodeId, name: this.#nameOf(p) };
			});

			await this.#mutate({
				kind: "rm -r",
				composite: false,
				bytes: PER_MUTATION_BASE_BYTES + plan.length * 80,
				run: async (tx) => {
					// Step 1: unlink the subtree root from its parent
					if (parentEntry) {
						await this.#dialect.deleteDirent(
							tx,
							this.#realId(parentEntry.inodeId),
							name,
							this.#sandboxId,
							...this.#expectedEpochArgs(),
						);
					}
					// Step 2: process each entry in post-order —
					//   • delete its internal dirent (for non-root entries)
					//   • decrement nlink; delete inode only when nlink reaches zero
					//   This preserves inodes still referenced by hardlinks outside the subtree.
					for (const step of plan) {
						if (step.parentInodeId !== undefined) {
							await this.#dialect.deleteDirent(
								tx,
								this.#realId(step.parentInodeId),
								step.name,
								this.#sandboxId,
								...this.#expectedEpochArgs(),
							);
						}
						const inodeId = this.#realId(step.inodeId);
						const newNlink = await this.#dialect.decrementNlink(tx, inodeId);
						if (newNlink === 0) await this.#dialect.deleteInode(tx, inodeId);
					}
					return [];
				},
			});

			// Update caches after successful DB operation
			for (const p of subtreePaths) {
				const e = this.#pathCache.get(p);
				if (e) this.#contentCache.delete(e.inodeId);
				this.#cacheDelete(p);
			}
			this.#dirty = true;
			return;
		}

		if (entry.kind === INODE_KIND.DIRECTORY) {
			// Non-recursive: only allow if empty
			if (this.#childPaths(path).length > 0) throw createEnotempty(path);
		}

		const parentInodeId = parentEntry!.inodeId;
		await this.#mutate(
			this.#dialect.rmComposite
				? {
						kind: "rm",
						composite: true,
						run: async (tx) => {
							await this.#dialect.rmComposite!(
								tx,
								this.#sandboxId,
								this.#realId(parentInodeId),
								name,
								...this.#expectedEpochArgs(),
							);
							return [];
						},
					}
				: {
						kind: "rm",
						composite: false,
						run: async (tx) => {
							const removedInodeId = await this.#dialect.deleteDirent(
								tx,
								this.#realId(parentInodeId),
								name,
								this.#sandboxId,
								...this.#expectedEpochArgs(),
							);
							const newNlink = await this.#dialect.decrementNlink(tx, removedInodeId);
							if (newNlink === 0) await this.#dialect.deleteInode(tx, removedInodeId);
							return [];
						},
					},
		);

		this.#contentCache.delete(entry.inodeId);
		this.#cacheDelete(path);
		this.#dirty = true;
	}

	async chmod(inputPath: string, mode: number): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "chmod");
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		await this.#mutate({
			kind: "chmod",
			composite: false,
			run: async (tx) => {
				await this.#dialect.updateInode(
					tx,
					this.#realId(entry.inodeId),
					{ mode },
					this.#sandboxId,
					...this.#expectedEpochArgs(),
				);
				return [];
			},
		});

		this.#updateCacheByInode(entry.inodeId, { mode });
		this.#dirty = true;
	}

	async utimes(inputPath: string, _atime: Date, mtime: Date): Promise<void> {
		const path = validatePath(inputPath);
		this.#assertWritable(path, "utimes");
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		await this.#mutate({
			kind: "utimes",
			composite: false,
			run: async (tx) => {
				await this.#dialect.updateInode(
					tx,
					this.#realId(entry.inodeId),
					{ mtime },
					this.#sandboxId,
					...this.#expectedEpochArgs(),
				);
				return [];
			},
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
		// Before the cache lookup on purpose: a warm cache makes the DB round trip free
		// but not the megabytes of string work the caller is about to do with the bytes.
		this.#assertExecFileSize(path, entry.size, "read");

		const cached = this.#contentCache.get(entry.inodeId);
		if (cached !== undefined) return cached;

		// Coalesce onto an in-flight prewarm fetch instead of racing it.
		if (this.#prewarmInFlight !== undefined) {
			await this.#prewarmInFlight;
			const afterPrewarm = this.#contentCache.get(entry.inodeId);
			if (afterPrewarm !== undefined) return afterPrewarm;
		}

		// `blobs` is global (no RLS), so a transaction wrapper is unnecessary.
		const data = await this.#db(() => this.#dialect.getBlobNoTx(entry.contentSha256!));
		const bytes = data ?? new Uint8Array(0);
		if (bytes.byteLength > 0) this.#contentCache.set(entry.inodeId, bytes);
		return bytes;
	}

	async readFile(inputPath: string, _options?: ReadFileOpts): Promise<string> {
		this.#assertScriptTxAlive();
		return new TextDecoder().decode(await this.#readBytes(inputPath));
	}

	async readFileBuffer(inputPath: string): Promise<Uint8Array> {
		this.#assertScriptTxAlive();
		return this.#readBytes(inputPath);
	}

	async exists(inputPath: string): Promise<boolean> {
		this.#assertScriptTxAlive();
		const path = validatePath(inputPath);
		return this.#pathCache.has(path);
	}

	async stat(inputPath: string): Promise<FsStat> {
		this.#assertScriptTxAlive();
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
		this.#assertScriptTxAlive();
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
		this.#assertScriptTxAlive();
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

			// Resolved from the pathCache HERE — see `rm -r`: a buffered replay runs after
			// this call's own cache updates, so reading it from the closure is wrong. Only
			// the parent whose inode this same copy creates is left to the replay, keyed by
			// dest path rather than id.
			const plan = srcPaths.map((srcPath) => {
				const entry = this.#pathCache.get(srcPath)!;
				const destPath = dest + srcPath.slice(src.length);
				const parentPath = this.#parentOf(destPath);
				return {
					destPath,
					name: this.#nameOf(destPath),
					parentPath,
					existingParentId: this.#pathCache.get(parentPath)?.inodeId,
					kind: entry.kind,
					mode: entry.mode,
					size: entry.size,
					contentSha256: entry.contentSha256,
					symlinkTarget: entry.symlinkTarget,
				};
			});

			const copiedIds = await this.#mutate({
				kind: "cp -r",
				composite: false,
				mints: plan.length,
				bytes: PER_MUTATION_BASE_BYTES + plan.reduce((n, step) => n + step.destPath.length * 2 + 120, 0),
				run: async (tx) => {
					const created = new Map<string, bigint>();
					const ids: bigint[] = [];
					for (const step of plan) {
						const fromThisCopy = created.get(step.parentPath);
						const parentInodeId =
							fromThisCopy ?? (step.existingParentId === undefined ? undefined : this.#realId(step.existingParentId));
						if (parentInodeId === undefined) throw createEnoent(step.parentPath);
						const newId = await this.#dialect.createInode(
							tx,
							{
								sandboxId: this.#sandboxId,
								kind: step.kind,
								mode: step.mode,
								size: step.size,
								contentSha256: step.contentSha256,
								symlinkTarget: step.symlinkTarget,
							},
							...this.#expectedEpochArgs(),
						);
						await this.#dialect.insertDirent(tx, parentInodeId, step.name, newId);
						created.set(step.destPath, newId);
						ids.push(newId);
					}
					return ids;
				},
			});
			for (let i = 0; i < plan.length; i++) newInodeIds.set(plan[i]!.destPath, copiedIds[i]!);

			// Update pathCache with all newly-created entries
			for (const [destPath, inodeId] of newInodeIds) {
				const srcPath = src + destPath.slice(dest.length);
				const srcE = this.#pathCache.get(srcPath)!;
				this.#cacheSet(destPath, { ...srcE, inodeId, mtime });
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
		const newInodeId = await this.#mutateOne({
			kind: "cp",
			composite: false,
			run: async (tx) => {
				const id = await this.#dialect.createInode(
					tx,
					{
						sandboxId: this.#sandboxId,
						kind: srcEntry.kind,
						mode: srcEntry.mode,
						size: srcEntry.size,
						contentSha256: srcEntry.contentSha256,
						symlinkTarget: srcEntry.symlinkTarget,
					},
					...this.#expectedEpochArgs(),
				);
				const oldInodeId = await this.#dialect.upsertDirent(tx, this.#realId(destParentEntry.inodeId), destName, id);
				if (oldInodeId !== null) {
					const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
					if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
				}
				return [id];
			},
		});

		this.#cacheSet(dest, {
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

		await this.#mutate(
			this.#dialect.mvComposite
				? {
						kind: "mv",
						composite: true,
						run: async (tx) => {
							await this.#dialect.mvComposite!(
								tx,
								this.#sandboxId,
								this.#realId(srcParentEntry.inodeId),
								srcName,
								this.#realId(destParentEntry.inodeId),
								destName,
								...this.#expectedEpochArgs(),
							);
							return [];
						},
					}
				: {
						kind: "mv",
						composite: false,
						run: async (tx) => {
							// moveDirent carries mv's fence-and-advance, so it must run FIRST:
							// an ESTALE has to abort before the destination's nlink is touched (#204).
							await this.#dialect.moveDirent(
								tx,
								this.#realId(srcParentEntry.inodeId),
								srcName,
								this.#realId(destParentEntry.inodeId),
								destName,
								this.#sandboxId,
								...this.#expectedEpochArgs(),
							);
							if (destEntry) {
								const destInodeId = this.#realId(destEntry.inodeId);
								const newNlink = await this.#dialect.decrementNlink(tx, destInodeId);
								if (newNlink === 0) await this.#dialect.deleteInode(tx, destInodeId);
							}
							return [];
						},
					},
		);

		// Snapshot src subtree before mutating the cache
		const srcPaths = this.#allPathsUnder(src);
		const snapshot = new Map<string, PathCacheEntry>();
		for (const p of srcPaths) {
			const e = this.#pathCache.get(p);
			if (e) snapshot.set(p, e);
		}

		// Remove src subtree and any existing dest subtree from cache
		for (const p of srcPaths) this.#cacheDelete(p);
		const destPrefix = dest === "/" ? "/" : `${dest}/`;
		for (const key of [...this.#pathCache.keys()]) {
			if (key === dest || key.startsWith(destPrefix)) this.#cacheDelete(key);
		}

		// Re-insert src entries under dest (remap prefix src → dest)
		for (const [oldPath, entry] of snapshot) {
			this.#cacheSet(dest + oldPath.slice(src.length), entry);
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

		const inodeId = await this.#mutateOne({
			kind: "symlink",
			composite: false,
			bytes: PER_MUTATION_BASE_BYTES + target.length,
			run: async (tx) => {
				const id = await this.#dialect.createInode(
					tx,
					{
						sandboxId: this.#sandboxId,
						kind: INODE_KIND.SYMLINK,
						mode: 0o777,
						size: target.length,
						symlinkTarget: target,
					},
					...this.#expectedEpochArgs(),
				);
				await this.#dialect.insertDirent(tx, this.#realId(parentEntry.inodeId), name, id);
				return [id];
			},
		});

		this.#cacheSet(linkPath, {
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

		await this.#mutate({
			kind: "link",
			composite: false,
			run: async (tx) => {
				const targetInodeId = this.#realId(srcEntry.inodeId);
				// incrementNlink carries link's fence-and-advance, so it must run FIRST:
				// an ESTALE has to abort before any dirent exists (#204).
				await this.#dialect.incrementNlink(tx, targetInodeId, this.#sandboxId, ...this.#expectedEpochArgs());
				await this.#dialect.insertDirent(tx, this.#realId(destParentEntry.inodeId), destName, targetInodeId);
				return [];
			},
		});

		this.#cacheSet(newPath, { ...srcEntry });
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
