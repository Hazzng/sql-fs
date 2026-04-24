/**
 * Session Manager — US-074
 * Maintains a pool of warm Bash sessions, keyed by (tenantId, sandboxId).
 *
 * Multi-tenant Phase 2: each tenant maps to its own Postgres database via
 * `TenantConfig`. Postgres backends (connection string + optional blob cache)
 * are lazily constructed per tenant; the session map is keyed by
 * `${tenantId}:${sandboxId}` so two tenants with colliding sandbox ids stay
 * isolated. Redis keys are NOT yet tenant-prefixed in this phase — Phase 3
 * threads the tenant id through the four Redis keyspaces.
 */

import { Mutex } from "async-mutex";
import type { Redis } from "ioredis";
import { Bash } from "just-bash";
import type { ExecOptions, IFileSystem } from "just-bash";
import type { BashExecResult } from "just-bash";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../fs/sql-fs/index.js";
import type { RedisBlobCache } from "../fs/sql-fs/redis-blob-cache.js";
import type { RedisPathSnapshot } from "../fs/sql-fs/redis-path-snapshot.js";
import type { ICoherentFs } from "../fs/sql-fs/sql-fs.js";
import type { PathCacheEntry } from "../fs/sql-fs/types.js";
import { type DistributedLockOptions, execLockKey, withDistributedLock } from "./distributed-lock.js";
import type { TenantConfig } from "./tenants.js";

/**
 * Internal structural type: the subset of `SqlFs` the session manager touches
 * for Phase E snapshot writes. Declared here (rather than exported from sql-fs)
 * to keep the cross-module surface narrow.
 */
type SnapshotWriterFs = ICoherentFs & { _getPathCache(): Map<string, PathCacheEntry> };

/** Narrowing helper: returns the fs as a snapshot writer if the hook is present. */
function asSnapshotWriter(fs: ICoherentFs): SnapshotWriterFs | undefined {
	return typeof (fs as Partial<SnapshotWriterFs>)._getPathCache === "function" ? (fs as SnapshotWriterFs) : undefined;
}

/** Redis key template for the per-sandbox monotonic version counter (Phase D). */
function versionKey(tenantId: string, sandboxId: string): string {
	return `vfs:${tenantId}:ver:${sandboxId}`;
}

/**
 * Stale-key TTL for `vfs:ver:*`. Seven days matches the longest realistic
 * idle window; after a full rollback the counter ages out automatically and
 * the next fresh create starts at version 0.
 */
const VERSION_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Runtime guard + narrowing cast: returns the `IFileSystem` as an
 * `ICoherentFs` if it supports reload/wasDirty/clearDirty, otherwise
 * `undefined`. The memory backend does NOT implement the interface.
 */
function asCoherentFs(fs: IFileSystem): ICoherentFs | undefined {
	const partial = fs as Partial<ICoherentFs>;
	if (
		typeof partial.reload === "function" &&
		typeof partial.wasDirty === "function" &&
		typeof partial.clearDirty === "function"
	) {
		return fs as ICoherentFs;
	}
	return undefined;
}

/**
 * Per-sandbox runtime opt-in flags. Runtimes must be declared at session creation
 * because `just-bash` decides which commands to register when the `Bash` instance is built.
 */
export interface RuntimeOptions {
	readonly python: boolean;
	readonly javascript: boolean;
}

const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = { python: false, javascript: false };

/** Matches `python3` or `python` as a standalone word (avoids false positives like `mypython`). */
const PYTHON_INVOCATION_REGEX = /\bpython3?\b/;
/** Matches `js-exec` or `node` as a standalone command word (avoids `mynode`, `nodejs-config`, etc). */
const JS_INVOCATION_REGEX = /\bjs-exec\b|\bnode\b/;

export interface Session {
	readonly fs: IFileSystem;
	readonly bash: Bash;
	readonly runtimeOptions: RuntimeOptions;
	readonly tenantId: string;
	lastUsed: number;
	inFlight: number;
	readonly mutex: Mutex;
	state: "active" | "closing";
	owner: string;
	createdAt: string;
	/** Estimated bytes consumed by pathCache: sum of (path.length + 100) per entry */
	pathCacheBytes: number;
	/** True when pathCacheBytes exceeds the configured budget — triggers eager eviction */
	overBudget: boolean;
	/** Set when destroy() is in progress — concurrent destroy calls await this for idempotency */
	destroyPromise?: Promise<void>;
	/**
	 * Last-known sandbox version counter observed from Redis (Phase D).
	 * 0 means "never synced" — treated as stale on first check so a fresh
	 * replica reloads its cache before serving the first request.
	 */
	lastSeenVersion: number;
}

/** Per-tenant lazy Postgres backend state. */
interface PerTenantBackend {
	readonly connectionString: string;
	readonly blobCache: RedisBlobCache | undefined;
}

export interface SessionManagerOptions {
	/**
	 * Tenant configuration used to resolve a tenant id → Postgres connection
	 * string. Required unless a `createFs` override is supplied (tests can
	 * bypass the real backend by injecting their own filesystem factory).
	 */
	readonly tenantConfig?: TenantConfig;
	/** Override for createPostgresSandboxFs — used by tests and non-Postgres backends. */
	readonly createFs?: (tenantId: string, sandboxId: string) => Promise<IFileSystem>;
	/** Override for destroyPostgresSandbox — used for dependency injection in tests. */
	readonly destroySandboxFn?: (tenantId: string, sandboxId: string) => Promise<void>;
	/** Idle timeout in ms before a session is eligible for eviction (default: SESSION_IDLE_MS env var or 600000) */
	readonly idleMs?: number;
	/** Max pathCache bytes per session before it is marked over-budget (default: 50MB) */
	readonly pathCacheMaxBytes?: number;
	/** Max concurrent Python executions across all sessions (default: MAX_CONCURRENT_PYTHON env var or 5) */
	readonly maxConcurrentPython?: number;
	/** Max concurrent JavaScript (js-exec/node) executions across all sessions (default: MAX_CONCURRENT_JS env var or 5) */
	readonly maxConcurrentJs?: number;
	/**
	 * Optional Redis client used to acquire a cross-replica distributed lock
	 * around every exec/destroy. When undefined the manager runs in
	 * single-replica mode (no distributed locking).
	 */
	readonly redis?: Redis;
	/** Overrides for the distributed exec lock (lease/renew/acquire timeouts). */
	readonly execLockOptions?: Partial<DistributedLockOptions>;
	/**
	 * Optional Redis path-snapshot cache (Phase E). When provided, the manager
	 * writes a fresh snapshot after each version bump and deletes the snapshot
	 * on sandbox destroy.
	 */
	readonly pathSnapshot?: RedisPathSnapshot;
	/**
	 * Factory constructing a per-tenant RedisBlobCache keyed by tenant id.
	 * Called at most once per tenant on first access (lazy).
	 */
	readonly blobCacheFactory?: (tenantId: string) => RedisBlobCache | undefined;
}

/** Internal FIFO-semaphore state shared by the python and js throttles. */
interface Semaphore {
	readonly limit: number;
	inFlight: number;
	readonly waiters: Array<() => void>;
}

export class SessionManager {
	/** Keyed by `${tenantId}:${sandboxId}` to isolate colliding sandbox ids across tenants. */
	private readonly sessions: Map<string, Session> = new Map();
	/** Single-flight map: tracks in-progress session creation, keyed by `${tenantId}:${sandboxId}`. */
	private readonly pending: Map<string, Promise<Session>> = new Map();
	/** Lazy per-tenant backend (connection string + blob cache). Keyed by tenantId. */
	private readonly backends: Map<string, PerTenantBackend> = new Map();
	private readonly tenantConfig: TenantConfig | undefined;
	private readonly createFsOverride: ((tenantId: string, sandboxId: string) => Promise<IFileSystem>) | undefined;
	private readonly destroySandboxFn: (tenantId: string, sandboxId: string) => Promise<void>;
	private readonly idleMs: number;
	private readonly pathCacheMaxBytes: number;
	private reaperTimer: ReturnType<typeof setInterval> | undefined;
	private readonly redis: Redis | undefined;
	private readonly execLockOptions: Partial<DistributedLockOptions> | undefined;
	private readonly pathSnapshot: RedisPathSnapshot | undefined;
	private readonly blobCacheFactory: ((tenantId: string) => RedisBlobCache | undefined) | undefined;

	// --- Runtime throttle semaphores (US-080a) ---
	/** Python runtime semaphore — caps CPython WASM workers (~80MB each). */
	private readonly pythonSem: Semaphore;
	/**
	 * JS runtime semaphore — caps QuickJS executions. Note: just-bash currently
	 * serializes `js-exec` internally via a single global worker, so this cap is
	 * an upper bound that may not be a binding constraint at runtime.
	 */
	private readonly jsSem: Semaphore;

	constructor({
		tenantConfig,
		createFs,
		destroySandboxFn,
		idleMs,
		pathCacheMaxBytes,
		maxConcurrentPython,
		maxConcurrentJs,
		redis,
		execLockOptions,
		pathSnapshot,
		blobCacheFactory,
	}: SessionManagerOptions) {
		this.tenantConfig = tenantConfig;
		this.createFsOverride = createFs;
		this.destroySandboxFn =
			destroySandboxFn ??
			((tenantId, sandboxId) => {
				// No tenantConfig means tests supplied a createFs override without a real
				// Postgres backend — destroy is a no-op at the storage layer in that case.
				if (this.tenantConfig === undefined) return Promise.resolve();
				const backend = this.getOrInitBackend(tenantId);
				return destroyPostgresSandbox(backend.connectionString, sandboxId);
			});
		this.idleMs = idleMs ?? Number(process.env.SESSION_IDLE_MS ?? "600000");
		this.pathCacheMaxBytes = pathCacheMaxBytes ?? 50 * 1024 * 1024;
		this.redis = redis;
		this.execLockOptions = execLockOptions;
		this.pathSnapshot = pathSnapshot;
		this.blobCacheFactory = blobCacheFactory;
		this.pythonSem = {
			limit: maxConcurrentPython ?? Number(process.env.MAX_CONCURRENT_PYTHON ?? "5"),
			inFlight: 0,
			waiters: [],
		};
		this.jsSem = {
			limit: maxConcurrentJs ?? Number(process.env.MAX_CONCURRENT_JS ?? "5"),
			inFlight: 0,
			waiters: [],
		};
	}

	/** Compose the internal session map key. */
	private sessionKey(tenantId: string, sandboxId: string): string {
		return `${tenantId}:${sandboxId}`;
	}

	/**
	 * Lazily materialize the per-tenant backend on first use. Throws if the
	 * tenant is unknown to the configured `TenantConfig`.
	 */
	private getOrInitBackend(tenantId: string): PerTenantBackend {
		const existing = this.backends.get(tenantId);
		if (existing !== undefined) return existing;
		if (this.tenantConfig === undefined) {
			throw new Error(
				`SessionManager: tenantConfig required to resolve tenant "${tenantId}" (no createFs override configured)`,
			);
		}
		const connectionString = this.tenantConfig.getConnectionString(tenantId);
		const backend: PerTenantBackend = {
			connectionString,
			blobCache: this.blobCacheFactory?.(tenantId),
		};
		this.backends.set(tenantId, backend);
		return backend;
	}

	/** Construct the underlying filesystem for a new session. */
	private async buildFs(tenantId: string, sandboxId: string): Promise<IFileSystem> {
		if (this.createFsOverride !== undefined) {
			return this.createFsOverride(tenantId, sandboxId);
		}
		const backend = this.getOrInitBackend(tenantId);
		return createPostgresSandboxFs(
			{
				connectionString: backend.connectionString,
				tenantId,
				blobCache: backend.blobCache,
				redis: this.redis,
				pathSnapshot: this.pathSnapshot,
			},
			sandboxId,
		);
	}

	/** Estimate bytes used by the pathCache: path.length + 100 overhead per entry */
	private estimatePathCacheBytes(fs: IFileSystem): number {
		const paths = fs.getAllPaths();
		let total = 0;
		for (const p of paths) {
			total += p.length + 100;
		}
		return total;
	}

	/**
	 * Returns an existing session or creates a new one.
	 * Concurrent calls for the same (tenantId, sandboxId) pair are coalesced into a single
	 * creation (single-flight).
	 *
	 * `runtimeOptions` are applied only on **cache miss** — the first caller "wins" the runtime flags.
	 * Subsequent callers receive the warm session regardless of the flags they pass.
	 *
	 * @param tenantId - Tenant identifier from the JWT claim / config.
	 * @param sandboxId - Sandbox id scoped within the tenant.
	 * @param runtimeOptions - Optional runtime opt-ins; only honored on first creation.
	 */
	async getOrCreate(tenantId: string, sandboxId: string, runtimeOptions?: RuntimeOptions): Promise<Session> {
		const key = this.sessionKey(tenantId, sandboxId);
		const existing = this.sessions.get(key);
		if (existing !== undefined) {
			existing.lastUsed = Date.now();
			return existing;
		}

		// If another getOrCreate is already creating this session, reuse its promise
		const inProgress = this.pending.get(key);
		if (inProgress !== undefined) {
			return inProgress;
		}

		const resolvedRuntime: RuntimeOptions = runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS;

		const creationPromise = (async (): Promise<Session> => {
			try {
				const fs = await this.buildFs(tenantId, sandboxId);
				// just-bash treats `false` and `undefined` both as off, but the types distinguish them —
				// `|| undefined` keeps types happy without changing behavior.
				const bash = new Bash({
					fs,
					python: resolvedRuntime.python || undefined,
					javascript: resolvedRuntime.javascript || undefined,
				});
				const pathCacheBytes = this.estimatePathCacheBytes(fs);

				// Stamp the session's initial version from Redis so the first exec
				// after `getOrCreate` does not trigger a spurious reload (the freshly
				// loaded pathCache already reflects DB state at this moment).
				let initialVersion = 0;
				if (this.redis !== undefined) {
					try {
						const raw = await this.redis.get(versionKey(tenantId, sandboxId));
						initialVersion = raw === null ? 0 : Number(raw) || 0;
					} catch {
						// Redis unavailable at bootstrap: treat as version 0. Subsequent
						// ensureFreshCache will retry and reload if necessary.
						initialVersion = 0;
					}
				}

				const session: Session = {
					fs,
					bash,
					runtimeOptions: resolvedRuntime,
					tenantId,
					lastUsed: Date.now(),
					inFlight: 0,
					mutex: new Mutex(),
					state: "active",
					owner: "",
					createdAt: new Date().toISOString(),
					pathCacheBytes,
					overBudget: pathCacheBytes > this.pathCacheMaxBytes,
					lastSeenVersion: initialVersion,
				};
				this.sessions.set(key, session);
				return session;
			} finally {
				this.pending.delete(key);
			}
		})();

		this.pending.set(key, creationPromise);
		return creationPromise;
	}

	/**
	 * Returns the session for the given (tenantId, sandboxId), or undefined if not found.
	 */
	getSession(tenantId: string, sandboxId: string): Session | undefined {
		return this.sessions.get(this.sessionKey(tenantId, sandboxId));
	}

	/**
	 * Runs `fn` while holding the cross-replica distributed lock for `(tenantId, sandboxId)`.
	 * No-op passthrough when no Redis client is configured (single-replica mode).
	 */
	private async withExecLock<T>(tenantId: string, sandboxId: string, fn: () => Promise<T>): Promise<T> {
		if (this.redis === undefined) return fn();
		return withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), fn, this.execLockOptions);
	}

	/**
	 * Cross-replica cache coherence (Phase D):
	 * Compares the session's `lastSeenVersion` against the shared Redis counter
	 * and reloads the filesystem cache if another replica has mutated state
	 * since this replica last ran. Also clears any stale dirty flag so
	 * publishVersionIfDirty only fires on writes from the current turn.
	 *
	 * No-op when Redis is unset or when the underlying filesystem is not
	 * coherence-aware (memory backend).
	 */
	private async ensureFreshCache(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		if (this.redis === undefined) return;
		const coherent = asCoherentFs(session.fs);
		if (coherent === undefined) return;

		let current: number;
		try {
			const raw = await this.redis.get(versionKey(tenantId, sandboxId));
			current = raw === null ? 0 : Number(raw) || 0;
		} catch (err) {
			// Redis transiently unavailable — freshness check is a best-effort
			// optimization. Skip the reload and let publishVersionIfDirty retry
			// the INCR at end-of-turn. Preserve any outstanding dirty bit so a
			// prior failed publish retries instead of being masked.
			console.error(JSON.stringify({ event: "version_get_error", sandboxId, error: (err as Error).message }));
			return;
		}

		if (session.lastSeenVersion !== current) {
			await coherent.reload();
			session.lastSeenVersion = current;
			// reload() already resets the dirty flag internally, but calling it
			// here too keeps the contract explicit and survives future edits
			// to reload().
			coherent.clearDirty();
			return;
		}
		// Versions match — do NOT clear the dirty flag here. If a previous
		// publishVersionIfDirty failed mid-turn (e.g., transient Redis error on
		// INCR), the flag must survive into end-of-turn publish so the pending
		// version bump retries rather than being silently dropped.
	}

	/**
	 * If the fs recorded a mutation during this turn, bumps the Redis
	 * version counter and updates `lastSeenVersion` so this replica does not
	 * reload on its own INCR. Also (re)applies the TTL so stale sandboxes
	 * age out of Redis after rollback.
	 */
	private async publishVersionIfDirty(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		if (this.redis === undefined) return;
		const coherent = asCoherentFs(session.fs);
		if (coherent === undefined) return;
		if (!coherent.wasDirty()) return;

		const key = versionKey(tenantId, sandboxId);
		let newVersion: number;
		try {
			newVersion = Number(await this.redis.incr(key));
		} catch (err) {
			// Mutation is already committed to Postgres. A transient Redis INCR
			// failure must NOT propagate up to the caller — the write succeeded.
			// Leave the dirty bit set so the next turn's publish retries the
			// bump. Other replicas will see stale caches until a subsequent
			// successful INCR (acceptable degradation under Redis outage).
			console.error(JSON.stringify({ event: "version_incr_error", sandboxId, error: (err as Error).message }));
			return;
		}
		// EXPIRE is best-effort; ignore failures (the counter is correct
		// regardless and a stale key without TTL only wastes a few bytes).
		try {
			await this.redis.expire(key, VERSION_KEY_TTL_SECONDS);
		} catch {
			// swallow
		}
		// Phase E: persist the pathCache snapshot tagged with the new version so
		// other replicas can cold-start without hitting the DB. Non-atomic with
		// INCR — strict version-equality in the reader catches the window.
		// `write` swallows Redis errors internally (fail open).
		if (this.pathSnapshot !== undefined) {
			const writer = asSnapshotWriter(coherent);
			if (writer !== undefined) {
				await this.pathSnapshot.write(tenantId, sandboxId, newVersion, writer._getPathCache());
			}
		}
		session.lastSeenVersion = newVersion;
		coherent.clearDirty();
	}

	/**
	 * Acquires the per-sandbox mutex, tracks inFlight, then calls fn(session).
	 * Same-sandbox operations are serialized — later requests wait for earlier ones.
	 *
	 * When a Redis client is configured, a cross-replica distributed lock wraps
	 * the local mutex so concurrent execs from different replicas also serialize.
	 *
	 * `runtimeOptions` are forwarded to `getOrCreate` — applied only on cache miss.
	 * A warm session ignores subsequent runtimeOptions; the first caller's flags stick.
	 *
	 * @param tenantId - Tenant identifier.
	 * @param sandboxId - Sandbox id scoped within the tenant.
	 */
	async withSession<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
	): Promise<T> {
		return this.withExecLock(tenantId, sandboxId, async () => {
			const session = await this.getOrCreate(tenantId, sandboxId, runtimeOptions);

			// Fast-fail: session is being destroyed — don't queue in the mutex
			if (session.state === "closing") {
				throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
			}

			// Cross-replica cache check — done inside the exec lock but outside
			// the session mutex so a reload cannot race with another turn on
			// this replica; we already hold the distributed lock which serializes
			// turns across replicas.
			await this.ensureFreshCache(tenantId, sandboxId, session);

			return session.mutex.runExclusive(async () => {
				// Re-check inside mutex in case destroy was called between the check above and acquiring the lock
				if (session.state === "closing") {
					throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
				}
				session.inFlight++;
				try {
					return await fn(session);
				} finally {
					// Publish even when fn threw: each SqlFs mutation is already
					// committed to Postgres before its dirty bit flips, so a
					// partially-completed exec can leave the DB ahead of every
					// peer's cache. Skipping the bump here would leave other
					// replicas serving stale reads until this replica happens to
					// run another successful turn.
					try {
						await this.publishVersionIfDirty(tenantId, sandboxId, session);
					} catch (err) {
						// Defensive: publishVersionIfDirty already swallows INCR
						// errors internally, but never let a finally-block hide
						// the primary error from fn.
						console.error(
							JSON.stringify({
								event: "publish_version_finally_error",
								sandboxId,
								error: (err as Error).message,
							}),
						);
					}
					session.inFlight--;
					session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
					session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
				}
			});
		});
	}

	/**
	 * Like withSession, but throws ENOENT if the sandbox is not already in the pool.
	 * Use this for operation routes that should NOT auto-create sandboxes.
	 *
	 * The cross-replica distributed lock is acquired before the pool check so a
	 * sandbox that exists only on another replica can't slip past serialization.
	 */
	async withExistingSession<T>(tenantId: string, sandboxId: string, fn: (session: Session) => Promise<T>): Promise<T> {
		return this.withExecLock(tenantId, sandboxId, async () => {
			const session = this.sessions.get(this.sessionKey(tenantId, sandboxId));
			if (session === undefined) {
				throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
			}

			if (session.state === "closing") {
				throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
			}

			await this.ensureFreshCache(tenantId, sandboxId, session);

			return session.mutex.runExclusive(async () => {
				if (session.state === "closing") {
					throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
				}
				session.inFlight++;
				session.lastUsed = Date.now();
				try {
					return await fn(session);
				} finally {
					// Publish even when fn threw — see comment in withSession.
					try {
						await this.publishVersionIfDirty(tenantId, sandboxId, session);
					} catch (err) {
						console.error(
							JSON.stringify({
								event: "publish_version_finally_error",
								sandboxId,
								error: (err as Error).message,
							}),
						);
					}
					session.inFlight--;
					session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
					session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
				}
			});
		});
	}

	/**
	 * Marks the session as closing, waits for any in-flight work to finish, then removes it
	 * from the pool and destroys backend data. Concurrent calls are idempotent — destroySandbox
	 * is called exactly once. Returns true if the session was in the pool, false otherwise.
	 * Even when the session is not in the pool, destroySandbox is still called for DB cleanup.
	 *
	 * The cross-replica distributed lock is held for the full destroy flow so a
	 * concurrent exec on another replica cannot interleave with the teardown.
	 */
	async destroy(tenantId: string, sandboxId: string): Promise<boolean> {
		return this.withExecLock(tenantId, sandboxId, async () => {
			const key = this.sessionKey(tenantId, sandboxId);
			const session = this.sessions.get(key);

			if (session === undefined) {
				// Session not in pool — still clean up backend data
				await this.destroySandboxFn(tenantId, sandboxId);
				await this.deleteVersionKey(tenantId, sandboxId);
				if (this.pathSnapshot !== undefined) {
					await this.pathSnapshot.delete(tenantId, sandboxId);
				}
				return false;
			}

			// Idempotent: concurrent destroy calls share the same promise
			if (session.destroyPromise !== undefined) {
				await session.destroyPromise;
				return true;
			}

			// Mark closing immediately — new withSession calls fail fast without queuing
			session.state = "closing";

			// Queue cleanup after any currently-running mutex holder finishes
			const p = session.mutex.runExclusive(async () => {
				this.sessions.delete(key);
				await this.destroySandboxFn(tenantId, sandboxId);
				await this.deleteVersionKey(tenantId, sandboxId);
				if (this.pathSnapshot !== undefined) {
					await this.pathSnapshot.delete(tenantId, sandboxId);
				}
			});
			session.destroyPromise = p;

			await p;
			return true;
		});
	}

	/**
	 * Deletes the Redis version counter for a sandbox. Called after successful
	 * destroy so a re-created sandbox with the same id starts at version 0.
	 * Best-effort: Redis errors are swallowed (the key will eventually age out
	 * via its TTL).
	 */
	private async deleteVersionKey(tenantId: string, sandboxId: string): Promise<void> {
		if (this.redis === undefined) return;
		try {
			await this.redis.del(versionKey(tenantId, sandboxId));
		} catch {
			// swallow — best-effort cleanup
		}
	}

	/**
	 * Starts the background idle-eviction reaper.
	 * Checks all sessions every intervalMs and evicts those idle longer than idleMs.
	 * Eviction drops in-memory state only — does NOT call destroySandbox.
	 */
	startReaper(intervalMs = 60_000): void {
		if (this.reaperTimer !== undefined) return;
		this.reaperTimer = setInterval(() => this.runReaper(), intervalMs);
	}

	/**
	 * Stops the background reaper.
	 */
	stopReaper(): void {
		if (this.reaperTimer !== undefined) {
			clearInterval(this.reaperTimer);
			this.reaperTimer = undefined;
		}
	}

	private runReaper(): void {
		const now = Date.now();
		for (const [key, session] of this.sessions) {
			if (session.state === "closing") continue;
			if (session.inFlight !== 0) continue;
			// Over-budget sessions are evicted immediately when idle (no idle timeout)
			if (session.overBudget || now - session.lastUsed > this.idleMs) {
				this.sessions.delete(key);
			}
		}
	}

	/**
	 * Acquires a semaphore slot, waiting if the concurrency cap is reached.
	 * Paired with release() in a try/finally.
	 */
	private acquireSlot(sem: Semaphore): Promise<void> {
		if (sem.inFlight < sem.limit) {
			sem.inFlight++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			sem.waiters.push(resolve);
		});
	}

	/**
	 * Releases a semaphore slot. If a waiter is queued, the slot is transferred directly
	 * (no decrement-then-increment) to avoid a counter race between a releaser and a
	 * concurrent acquirer running in the same microtask turn.
	 */
	private releaseSlot(sem: Semaphore): void {
		const next = sem.waiters.shift();
		if (next !== undefined) {
			next();
			return;
		}
		sem.inFlight--;
	}

	/**
	 * Executes a script through the session's Bash. When the script looks like it invokes
	 * Python or JS and the session opted into the corresponding runtime, routes through
	 * the matching global semaphore(s) to cap concurrent WASM workers.
	 *
	 * When a script uses both runtimes, semaphores are acquired in a fixed order (python
	 * first, then js) to avoid deadlock across concurrent callers needing both slots.
	 */
	async execWithRuntimeThrottle(session: Session, script: string, opts?: ExecOptions): Promise<BashExecResult> {
		const usesPython = session.runtimeOptions.python && PYTHON_INVOCATION_REGEX.test(script);
		const usesJs = session.runtimeOptions.javascript && JS_INVOCATION_REGEX.test(script);

		if (!usesPython && !usesJs) {
			return session.bash.exec(script, opts);
		}

		// Acquire in a fixed order: python → js. Release in reverse.
		if (usesPython) await this.acquireSlot(this.pythonSem);
		if (usesJs) {
			try {
				await this.acquireSlot(this.jsSem);
			} catch (e) {
				// acquireSlot never rejects today, but if it ever does we still need to release python
				if (usesPython) this.releaseSlot(this.pythonSem);
				throw e;
			}
		}

		try {
			return await session.bash.exec(script, opts);
		} finally {
			if (usesJs) this.releaseSlot(this.jsSem);
			if (usesPython) this.releaseSlot(this.pythonSem);
		}
	}
}
