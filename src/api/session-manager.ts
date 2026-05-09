/**
 * Session Manager — US-074
 * Maintains a pool of warm Bash sessions, keyed by (tenantId, sandboxId).
 *
 * Multi-tenant: each tenant maps to its own Postgres database via
 * `TenantConfig`. Postgres backends (connection string + optional blob cache)
 * are lazily constructed per tenant; the session map is keyed by
 * `${tenantId}:${sandboxId}` so two tenants with colliding sandbox ids stay
 * isolated. Redis keys are tenant-prefixed (`vfs:${tenantId}:...`) — the
 * tenantId is propagated into snapshot operations and every Redis key generator
 * (locks, version counters, path snapshots, blob cache) so cross-tenant key
 * collisions are impossible.
 */

import { Mutex } from "async-mutex";
import type { Redis } from "ioredis";
import { Bash } from "just-bash";
import type { BashExecResult, DefenseInDepthConfig, ExecOptions, IFileSystem, SecurityViolation } from "just-bash";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../fs/sql-fs/index.js";
import type { RedisBlobCache } from "../fs/sql-fs/redis-blob-cache.js";
import { type RedisPathSnapshot, versionKey } from "../fs/sql-fs/redis-path-snapshot.js";
import { SessionScopedFs } from "../fs/sql-fs/session-scoped-fs.js";
import type { ICoherentFs, IScriptTxFs } from "../fs/sql-fs/sql-fs.js";
import type { PathCacheEntry, SandboxListEntry, SandboxMeta } from "../fs/sql-fs/types.js";
import { type DistributedLockOptions, execLockKey, withDistributedLock } from "./distributed-lock.js";
import { logAudit } from "./lib/audit.js";
import type { TenantConfig } from "./tenants.js";

type SnapshotWriterFs = ICoherentFs & { _getPathCache(): Map<string, PathCacheEntry> };

function asSnapshotWriter(fs: ICoherentFs): SnapshotWriterFs | undefined {
	return typeof (fs as Partial<SnapshotWriterFs>)._getPathCache === "function" ? (fs as SnapshotWriterFs) : undefined;
}

/**
 * Stale-key TTL for `vfs:{tenantId}:ver:*`. Seven days matches the longest realistic
 * idle window; after a full rollback the counter ages out automatically and
 * the next fresh create starts at version 0.
 */
const VERSION_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;

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

function asScriptTxFs(fs: IFileSystem): IScriptTxFs | undefined {
	const partial = fs as Partial<IScriptTxFs>;
	if (
		typeof partial.beginScriptScope === "function" &&
		typeof partial.endScriptScope === "function" &&
		typeof partial.abortScriptScope === "function" &&
		typeof partial.reload === "function" &&
		typeof partial.wasDirty === "function" &&
		typeof partial.clearDirty === "function"
	) {
		return fs as IScriptTxFs;
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
	readonly scriptTx: SessionScopedFs | undefined;
	lastUsed: number;
	inFlight: number;
	readonly mutex: Mutex;
	state: "active" | "closing";
	owner: string;
	name: string | null;
	createdAt: string;
	pathCacheBytes: number;
	overBudget: boolean;
	destroyPromise?: Promise<void>;
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
	 * string. Required unless a `createFs` override is supplied.
	 */
	readonly tenantConfig?: TenantConfig;
	/** Override for createPostgresSandboxFs — used by tests and non-Postgres backends. */
	readonly createFs?: (tenantId: string, sandboxId: string) => Promise<IFileSystem>;
	/** Override for destroyPostgresSandbox — used for dependency injection in tests. */
	readonly destroySandboxFn?: (tenantId: string, sandboxId: string) => Promise<void>;
	readonly idleMs?: number;
	readonly pathCacheMaxBytes?: number;
	readonly maxConcurrentPython?: number;
	readonly maxConcurrentJs?: number;
	readonly redis?: Redis;
	readonly execLockOptions?: Partial<DistributedLockOptions>;
	readonly pathSnapshot?: RedisPathSnapshot;
	/** Factory constructing a per-tenant RedisBlobCache. Called at most once per tenant on first access (lazy). */
	readonly blobCacheFactory?: (tenantId: string) => RedisBlobCache | undefined;
	/**
	 * Reads sandbox metadata from the persistent store (Postgres) for the given
	 * tenant. Returns null when the sandbox doesn't exist. Required for
	 * withSessionOrRehydrate to restore owner + runtimeOptions on cold replicas.
	 */
	readonly getSandboxMetaFn?: (tenantId: string, sandboxId: string) => Promise<SandboxMeta | null>;
	/**
	 * Persists sandbox metadata (owner, runtime flags) to the per-tenant store.
	 * Called from `persistSandboxMeta` after sandbox creation.
	 */
	readonly persistSandboxMetaFn?: (tenantId: string, sandboxId: string, meta: SandboxMeta) => Promise<void>;
	/**
	 * Lists all sandboxes from the persistent store for the given tenant,
	 * optionally filtered by owner.
	 */
	readonly listSandboxesFn?: (tenantId: string, owner?: string) => Promise<SandboxListEntry[]>;
	/**
	 * Override for `JUST_BASH_DEFENSE_IN_DEPTH` env var — used by tests and
	 * non-default configurations. When `true`, enables just-bash's defense-in-depth
	 * security layer on each `Bash` instance.
	 */
	readonly defenseInDepth?: boolean;
	/**
	 * Override for `JUST_BASH_DEFENSE_AUDIT_MODE` env var. When `true` (default),
	 * violations are logged but not thrown — safe for initial rollout observation.
	 * Flip to `false` once logs are clean to enforce the security boundary.
	 */
	readonly defenseAuditMode?: boolean;
}

interface Semaphore {
	readonly limit: number;
	inFlight: number;
	readonly waiters: Array<() => void>;
}

export class SessionManager {
	/** Keyed by `${tenantId}:${sandboxId}` to isolate colliding sandbox ids across tenants. */
	private readonly sessions: Map<string, Session> = new Map();
	private readonly pending: Map<string, Promise<Session>> = new Map();
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
	private readonly getSandboxMetaFn?: (tenantId: string, sandboxId: string) => Promise<SandboxMeta | null>;
	private readonly persistSandboxMetaFn?: (tenantId: string, sandboxId: string, meta: SandboxMeta) => Promise<void>;
	private readonly listSandboxesFn?: (tenantId: string, owner?: string) => Promise<SandboxListEntry[]>;

	private readonly pythonSem: Semaphore;
	private readonly jsSem: Semaphore;
	private readonly defenseInDepth: boolean;
	private readonly defenseAuditMode: boolean;

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
		getSandboxMetaFn,
		persistSandboxMetaFn,
		listSandboxesFn,
		defenseInDepth,
		defenseAuditMode,
	}: SessionManagerOptions) {
		this.tenantConfig = tenantConfig;
		this.createFsOverride = createFs;
		this.destroySandboxFn =
			destroySandboxFn ??
			((tenantId, sandboxId) => {
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
		this.getSandboxMetaFn = getSandboxMetaFn;
		this.persistSandboxMetaFn = persistSandboxMetaFn;
		this.listSandboxesFn = listSandboxesFn;
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
		this.defenseInDepth = defenseInDepth ?? process.env.JUST_BASH_DEFENSE_IN_DEPTH === "true";
		this.defenseAuditMode = defenseAuditMode ?? process.env.JUST_BASH_DEFENSE_AUDIT_MODE !== "false";
	}

	private sessionKey(tenantId: string, sandboxId: string): string {
		return `${tenantId}:${sandboxId}`;
	}

	private getOrInitBackend(tenantId: string): PerTenantBackend {
		const existing = this.backends.get(tenantId);
		if (existing !== undefined) return existing;
		if (this.tenantConfig === undefined) {
			throw Object.assign(
				new Error(
					`SessionManager: tenantConfig required to resolve tenant "${tenantId}" (no createFs override configured)`,
				),
				{ code: "EINVAL" as const },
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

	private async buildFs(
		tenantId: string,
		sandboxId: string,
		owner = "",
	): Promise<{ fs: IFileSystem; resolvedOwner: string }> {
		if (this.createFsOverride !== undefined) {
			return { fs: await this.createFsOverride(tenantId, sandboxId), resolvedOwner: owner };
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
			owner,
		);
	}

	private estimatePathCacheBytes(fs: IFileSystem): number {
		const paths = fs.getAllPaths();
		let total = 0;
		for (const p of paths) {
			total += p.length + 100;
		}
		return total;
	}

	async getOrCreate(
		tenantId: string,
		sandboxId: string,
		runtimeOptions?: RuntimeOptions,
		owner = "",
	): Promise<Session> {
		const key = this.sessionKey(tenantId, sandboxId);
		const existing = this.sessions.get(key);
		if (existing !== undefined) {
			existing.lastUsed = Date.now();
			return existing;
		}

		const inProgress = this.pending.get(key);
		if (inProgress !== undefined) {
			return inProgress;
		}

		const resolvedRuntime: RuntimeOptions = runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS;

		const creationPromise = (async (): Promise<Session> => {
			try {
				const { fs, resolvedOwner } = await this.buildFs(tenantId, sandboxId, owner);
				const defenseInDepthConfig: DefenseInDepthConfig | false = this.defenseInDepth
					? {
							enabled: true,
							auditMode: this.defenseAuditMode,
							onViolation: (v: SecurityViolation) => logAudit("defense_in_depth_violation", { sandboxId, ...v }),
						}
					: false;
				const bash = new Bash({
					fs,
					python: resolvedRuntime.python || undefined,
					javascript: resolvedRuntime.javascript || undefined,
					defenseInDepth: defenseInDepthConfig,
				});
				const pathCacheBytes = this.estimatePathCacheBytes(fs);
				const scriptTxFs = asScriptTxFs(fs);
				const scriptTx = scriptTxFs !== undefined ? new SessionScopedFs(scriptTxFs) : undefined;

				let initialVersion = 0;
				if (this.redis !== undefined) {
					try {
						const raw = await this.redis.get(versionKey(tenantId, sandboxId));
						initialVersion = raw === null ? 0 : Number(raw) || 0;
					} catch {
						initialVersion = 0;
					}
				}

				const session: Session = {
					fs,
					bash,
					runtimeOptions: resolvedRuntime,
					tenantId,
					scriptTx,
					lastUsed: Date.now(),
					inFlight: 0,
					mutex: new Mutex(),
					state: "active",
					owner: resolvedOwner,
					name: null,
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

	getSession(tenantId: string, sandboxId: string): Session | undefined {
		return this.sessions.get(this.sessionKey(tenantId, sandboxId));
	}

	private async withExecLock<T>(tenantId: string, sandboxId: string, fn: () => Promise<T>): Promise<T> {
		if (this.redis === undefined) return fn();
		return withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), fn, this.execLockOptions);
	}

	/** Shared entry logic for all session wrappers. Must be called inside the distributed exec lock. */
	private async withSessionEntry<T>(
		tenantId: string,
		sandboxId: string,
		session: Session,
		fn: (session: Session) => Promise<T>,
	): Promise<T> {
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
				const coherent = asCoherentFs(session.fs);
				const shouldRefreshPathBudget = coherent === undefined || coherent.wasDirty();
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
				if (shouldRefreshPathBudget) {
					session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
					session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
				}
			}
		});
	}

	private async ensureFreshCache(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		if (this.redis === undefined) return;
		const coherent = asCoherentFs(session.fs);
		if (coherent === undefined) return;

		let current: number;
		try {
			const raw = await this.redis.get(versionKey(tenantId, sandboxId));
			current = raw === null ? 0 : Number(raw) || 0;
		} catch (err) {
			// Redis unavailable — can't determine whether the cache is fresh.
			// Reload from Postgres so we don't serve stale data.
			console.error(JSON.stringify({ event: "version_get_error", sandboxId, error: (err as Error).message }));
			await coherent.reload();
			return;
		}

		if (session.lastSeenVersion !== current) {
			await coherent.reload();
			session.lastSeenVersion = current;
			coherent.clearDirty();
			return;
		}
	}

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
			console.error(JSON.stringify({ event: "version_incr_error", sandboxId, error: (err as Error).message }));
			return;
		}
		try {
			await this.redis.expire(key, VERSION_KEY_TTL_SECONDS);
		} catch {
			// swallow
		}
		if (this.pathSnapshot !== undefined) {
			const writer = asSnapshotWriter(coherent);
			if (writer !== undefined) {
				await this.pathSnapshot.write(tenantId, sandboxId, newVersion, writer._getPathCache());
			}
		}
		session.lastSeenVersion = newVersion;
		coherent.clearDirty();
	}

	async withSession<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
		owner = "",
	): Promise<T> {
		return this.withExecLock(tenantId, sandboxId, async () => {
			const session = await this.getOrCreate(tenantId, sandboxId, runtimeOptions, owner);
			return this.withSessionEntry(tenantId, sandboxId, session, fn);
		});
	}

	async withExistingSession<T>(tenantId: string, sandboxId: string, fn: (session: Session) => Promise<T>): Promise<T> {
		return this.withExecLock(tenantId, sandboxId, async () => {
			const session = this.sessions.get(this.sessionKey(tenantId, sandboxId));
			if (session === undefined) {
				throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
			}
			return this.withSessionEntry(tenantId, sandboxId, session, fn);
		});
	}

	/**
	 * Like withExistingSession, but falls back to Postgres to check if the sandbox
	 * exists before throwing ENOENT. If the sandbox is in Postgres but not in the
	 * pool (evicted by reaper, or created on another replica), rehydrates it via
	 * getOrCreate. Falls back to withExistingSession behavior when getSandboxMetaFn
	 * is undefined.
	 */
	async withSessionOrRehydrate<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
	): Promise<T> {
		return this.withExecLock(tenantId, sandboxId, async () => {
			const session = this.sessions.get(this.sessionKey(tenantId, sandboxId));
			if (session !== undefined && session.state !== "closing") {
				return this.withSessionEntry(tenantId, sandboxId, session, fn);
			}
			return this.rehydrateAndExec(tenantId, sandboxId, fn, runtimeOptions);
		});
	}

	private async rehydrateAndExec<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
	): Promise<T> {
		let meta: SandboxMeta | null | undefined;
		if (this.getSandboxMetaFn !== undefined) {
			meta = await this.getSandboxMetaFn(tenantId, sandboxId);
			if (meta === null) {
				throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
			}
		} else {
			throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
		}
		const resolvedRuntime: RuntimeOptions = meta
			? { python: meta.python, javascript: meta.javascript }
			: (runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS);
		const session = await this.getOrCreate(tenantId, sandboxId, resolvedRuntime, meta?.owner ?? "");
		if (meta?.owner) {
			session.owner = meta.owner;
		}
		if (meta?.name !== undefined) {
			session.name = meta.name;
		}
		return this.withSessionEntry(tenantId, sandboxId, session, fn);
	}

	async persistSandboxMeta(tenantId: string, sandboxId: string, meta: SandboxMeta): Promise<void> {
		if (this.persistSandboxMetaFn !== undefined) {
			await this.persistSandboxMetaFn(tenantId, sandboxId, meta);
		}
	}

	async listSandboxes(tenantId: string, owner?: string): Promise<SandboxListEntry[]> {
		if (this.listSandboxesFn === undefined) {
			throw Object.assign(new Error("listSandboxes not configured"), { code: "ENOTSUP" });
		}
		return this.listSandboxesFn(tenantId, owner);
	}

	async destroy(tenantId: string, sandboxId: string): Promise<boolean> {
		return this.withExecLock(tenantId, sandboxId, async () => {
			const key = this.sessionKey(tenantId, sandboxId);
			const session = this.sessions.get(key);

			if (session === undefined) {
				await this.destroySandboxFn(tenantId, sandboxId);
				await this.deleteVersionKey(tenantId, sandboxId);
				if (this.pathSnapshot !== undefined) {
					await this.pathSnapshot.delete(tenantId, sandboxId);
				}
				return false;
			}

			if (session.destroyPromise !== undefined) {
				await session.destroyPromise;
				return true;
			}

			session.state = "closing";

			const p = session.mutex.runExclusive(async () => {
				this.sessions.delete(key);
				await this.destroySandboxFn(tenantId, sandboxId);
				await this.deleteVersionKey(tenantId, sandboxId);
				if (this.pathSnapshot !== undefined) {
					await this.pathSnapshot.delete(tenantId, sandboxId);
				}
				await this.disconnectFs(session.fs);
			});
			session.destroyPromise = p;

			await p;
			return true;
		});
	}

	private async deleteVersionKey(tenantId: string, sandboxId: string): Promise<void> {
		if (this.redis === undefined) return;
		try {
			await this.redis.del(versionKey(tenantId, sandboxId));
		} catch {
			// swallow — best-effort cleanup
		}
	}

	startReaper(intervalMs = 60_000): void {
		if (this.reaperTimer !== undefined) return;
		this.reaperTimer = setInterval(() => this.runReaper(), intervalMs);
	}

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
			if (session.overBudget || now - session.lastUsed > this.idleMs) {
				this.sessions.delete(key);
				void this.disconnectFs(session.fs);
			}
		}
	}

	private async disconnectFs(fs: IFileSystem): Promise<void> {
		const disconnectable = fs as { disconnect?: () => Promise<void> };
		if (typeof disconnectable.disconnect === "function") {
			try {
				await disconnectable.disconnect();
			} catch {
				// best-effort — pool is being torn down
			}
		}
	}

	private acquireSlot(sem: Semaphore): Promise<void> {
		if (sem.inFlight < sem.limit) {
			sem.inFlight++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			sem.waiters.push(resolve);
		});
	}

	private releaseSlot(sem: Semaphore): void {
		const next = sem.waiters.shift();
		if (next !== undefined) {
			next();
			return;
		}
		sem.inFlight--;
	}

	async execWithRuntimeThrottle(session: Session, script: string, opts?: ExecOptions): Promise<BashExecResult> {
		const usesPython = session.runtimeOptions.python && PYTHON_INVOCATION_REGEX.test(script);
		const usesJs = session.runtimeOptions.javascript && JS_INVOCATION_REGEX.test(script);

		const execFn = async (): Promise<BashExecResult> => {
			if (session.scriptTx !== undefined) {
				session.scriptTx.beginScope();
				try {
					const result = await session.bash.exec(script, opts);
					await session.scriptTx.endScope();
					return result;
				} catch (err) {
					await session.scriptTx.abortScope();
					throw err;
				}
			}
			return session.bash.exec(script, opts);
		};

		if (!usesPython && !usesJs) {
			return execFn();
		}

		if (usesPython) await this.acquireSlot(this.pythonSem);
		if (usesJs) {
			try {
				await this.acquireSlot(this.jsSem);
			} catch (e) {
				if (usesPython) this.releaseSlot(this.pythonSem);
				throw e;
			}
		}

		try {
			return await execFn();
		} finally {
			if (usesJs) this.releaseSlot(this.jsSem);
			if (usesPython) this.releaseSlot(this.pythonSem);
		}
	}
}
