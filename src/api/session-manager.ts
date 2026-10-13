import type { Redis } from "ioredis";
import type { BashExecResult, ExecOptions, IFileSystem } from "just-bash";
import { createEnoent } from "../sql-fs/errors.js";
import { createPostgresSandboxFs, destroyPostgresSandbox, retirePostgresSandboxGeneration } from "../sql-fs/index.js";
import type { RedisBlobCache } from "../sql-fs/redis-blob-cache.js";
import type { ScriptTxBufferConfig } from "../sql-fs/script-tx-buffer.js";
import type { ICoherentFs, IReadOnlyScopeFs } from "../sql-fs/sql-fs.js";
import type { SandboxListEntry, SandboxMeta } from "../sql-fs/types.js";
import type { GitIdentity } from "./commands/git-command.js";
import { execLockKey, withDistributedLock } from "./distributed-lock.js";
import { type DistributedRWLockOptions, rwLockKeys, withDistributedRWLock } from "./distributed-rw-lock.js";
import { execFsError, extractErrCode, preservesAmbiguousOutcome } from "./errors.js";
import { logAudit } from "./lib/audit.js";
// NOTE: `py-exec` (warm host Python) is intentionally NOT imported/wired here.
// It spawned the HOST python3 with full `process.env`, which is a sandbox
// escape (RCE + secret/credential exfil — audit C1). The WASM `python3`
// command from just-bash (enabled via `python: true` below) is the safe path.
import { type ReadOnlyContext, readOnlyContext } from "./read-only-context.js";
import { RWLock } from "./rw-lock.js";
import { sessionLeaseContext } from "./session-lease-context.js";
import {
	type RuntimeOptions,
	type SessionRuntime,
	buildGitIdentity,
	buildSandboxBaseEnv,
	createSessionRuntime,
	executeSessionRuntime,
} from "./session-runtime/engine.js";
export { buildGitIdentity, buildSandboxBaseEnv, deriveExecGitCredentials } from "./session-runtime/engine.js";
export type { RuntimeOptions, SessionScriptScope } from "./session-runtime/engine.js";

import type { TenantConfig } from "./tenants.js";
import { WorkerFileSystem, WorkerScriptScope } from "./worker-owner/filesystem.js";
import { assertWorkerMessageBudget } from "./worker-owner/message-budget.js";
import {
	WorkerOwnerPool,
	type WorkerPoolOptions,
	type WorkerReservation,
	loadWorkerPoolOptions,
	workerReservation,
} from "./worker-owner/pool.js";
import type { ShellExecutionLimits } from "./worker-owner/protocol.js";
import { OutcomeUnknownError } from "./worker-owner/protocol.js";

function asCoherentFs(fs: IFileSystem): ICoherentFs | undefined {
	const partial = fs as Partial<ICoherentFs>;
	if (
		typeof partial.ensureFresh === "function" &&
		typeof partial.reload === "function" &&
		typeof partial.wasDirty === "function" &&
		typeof partial.clearDirty === "function" &&
		typeof partial.poisoned === "function"
	) {
		return fs as ICoherentFs;
	}
	return undefined;
}

function asReadOnlyFs(fs: IFileSystem): IReadOnlyScopeFs | undefined {
	const partial = fs as Partial<IReadOnlyScopeFs>;
	if (typeof partial.beginReadOnlyScope === "function" && typeof partial.endReadOnlyScope === "function") {
		return fs as IReadOnlyScopeFs;
	}
	return undefined;
}

const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = { python: false, javascript: false, network: false };

const SANDBOX_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSandboxId(id: string): boolean {
	return SANDBOX_ID_RE.test(id);
}

function assertValidSandboxId(sandboxId: string): void {
	if (!isValidSandboxId(sandboxId)) {
		throw Object.assign(new Error("EINVAL: invalid sandbox id"), { code: "EINVAL" });
	}
}

export interface Session extends SessionRuntime {
	bash: SessionRuntime["bash"];
	runtimeOptions: RuntimeOptions;
	lastUsed: number;
	inFlight: number;
	/**
	 * Per-session async readers-writer lock. Writes (default exec path,
	 * destroy, reaper, shutdown) take exclusive mode; readOnly execs take
	 * shared mode and run in parallel.
	 */
	readonly lock: RWLock;
	state: "active" | "closing";
	owner: string;
	name: string | null;
	createdAt: string;
	pathCacheBytes: number;
	overBudget: boolean;
	destroyPromise?: Promise<void>;
	/**
	 * Tracked working directory for this session.
	 *
	 * just-bash's `bash.exec()` runs each call against a **copy** of the
	 * interpreter state (env + cwd). Any `cd` executed inside a script
	 * modifies only that copy and is discarded once the call returns —
	 * `bash.getCwd()` never changes. We therefore mirror the cwd ourselves:
	 *
	 * - Initialised from `bash.getCwd()` at session creation (typically `/home/user`).
	 * - After every **non-readOnly** exec we read `result.env.PWD`, which
	 *   just-bash always populates with the final working directory, and store
	 *   it here.
	 * - Before each exec we pass this value as `opts.cwd` (unless the caller
	 *   already supplied an explicit `cwd` in the request body).
	 *
	 * Semantics: cwd is **session-scoped** and **per-sandbox** — two sandboxes
	 * are completely independent, and the cwd resets to `/home/user` only when
	 * the session is evicted (idle timeout or explicit destroy).
	 * readOnly execs use the current `session.cwd` as their starting directory
	 * but do not update it, consistent with the read-only contract.
	 */
	cwd: string;
}

/** Per-tenant lazy Postgres backend state. */
interface PerTenantBackend {
	readonly connectionString: string;
	readonly blobCache: RedisBlobCache | undefined;
}

export interface SessionManagerOptions {
	readonly workerEnabled?: boolean;
	readonly executionLimits?: ShellExecutionLimits;
	readonly scriptTxBuffer?: ScriptTxBufferConfig;
	readonly postgresPoolMax?: number;
	readonly workerOptions?: WorkerPoolOptions;
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
	readonly execLockOptions?: Partial<DistributedRWLockOptions>;
	/** Feature flag: use the distributed RW lock keyspace. Set to false during rolling deploys. Defaults to true. */
	readonly rwlockEnabled?: boolean;
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
	/** Changes runtime flags in the store and advances the sandbox epoch. Resolves null for a missing sandbox. */
	readonly updateSandboxRuntimeFn?: (
		tenantId: string,
		sandboxId: string,
		runtime: Partial<RuntimeOptions>,
	) => Promise<SandboxMeta | null>;
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

interface SemaphoreWaiter {
	readonly resolve: () => void;
	readonly reject: (err: Error) => void;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
	readonly onAbort: (() => void) | undefined;
	readonly signal: AbortSignal | undefined;
	settled: boolean;
}

interface Semaphore {
	readonly limit: number;
	readonly maxWaiters: number;
	readonly waitTimeoutMs: number;
	inFlight: number;
	readonly waiters: SemaphoreWaiter[];
}

export class RuntimeBackpressureError extends Error {
	readonly code = "ERUNTIME_BUSY";
	constructor(runtime: string) {
		super(`ERUNTIME_BUSY: ${runtime} runtime queue is full or wait timed out`);
		this.name = "RuntimeBackpressureError";
	}
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
	private readonly execLockOptions: Partial<DistributedRWLockOptions> | undefined;
	private readonly rwlockEnabled: boolean;
	private readonly blobCacheFactory: ((tenantId: string) => RedisBlobCache | undefined) | undefined;
	private readonly getSandboxMetaFn?: (tenantId: string, sandboxId: string) => Promise<SandboxMeta | null>;
	private readonly persistSandboxMetaFn?: (tenantId: string, sandboxId: string, meta: SandboxMeta) => Promise<void>;
	private readonly updateSandboxRuntimeFn?: SessionManagerOptions["updateSandboxRuntimeFn"];
	private readonly listSandboxesFn?: (tenantId: string, owner?: string) => Promise<SandboxListEntry[]>;

	private readonly pythonSem: Semaphore;
	private readonly jsSem: Semaphore;
	private readonly defenseInDepth: boolean;
	private readonly defenseAuditMode: boolean;
	private readonly sandboxBaseEnv: Record<string, string>;
	private readonly gitIdentity: GitIdentity | undefined;
	private shuttingDown = false;
	private readonly workerPool: WorkerOwnerPool | undefined;
	private readonly workerRecoveries = new WeakMap<
		WorkerReservation,
		{ readonly generation: number; readonly task: Promise<void> }
	>();
	private readonly executionLimits: ShellExecutionLimits | undefined;
	private readonly scriptTxBuffer: ScriptTxBufferConfig | undefined;
	private readonly postgresPoolMax: number | undefined;

	constructor({
		workerEnabled,
		workerOptions,
		executionLimits,
		scriptTxBuffer,
		postgresPoolMax,
		tenantConfig,
		createFs,
		destroySandboxFn,
		idleMs,
		pathCacheMaxBytes,
		maxConcurrentPython,
		maxConcurrentJs,
		redis,
		execLockOptions,
		rwlockEnabled,
		blobCacheFactory,
		getSandboxMetaFn,
		persistSandboxMetaFn,
		updateSandboxRuntimeFn,
		listSandboxesFn,
		defenseInDepth,
		defenseAuditMode,
	}: SessionManagerOptions) {
		this.tenantConfig = tenantConfig;
		this.executionLimits = executionLimits;
		this.scriptTxBuffer = scriptTxBuffer;
		this.postgresPoolMax = postgresPoolMax;
		this.createFsOverride = createFs;
		this.destroySandboxFn =
			destroySandboxFn ??
			((tenantId, sandboxId) => {
				if (this.tenantConfig === undefined) return Promise.resolve();
				const backend = this.getOrInitBackend(tenantId);
				return destroyPostgresSandbox(backend.connectionString, sandboxId);
			});
		this.idleMs = idleMs ?? Number(process.env.SESSION_IDLE_MS ?? "600000");
		this.redis = redis;
		this.pathCacheMaxBytes = pathCacheMaxBytes ?? 50 * 1024 * 1024;
		this.execLockOptions = execLockOptions;
		this.rwlockEnabled = rwlockEnabled ?? true;
		this.blobCacheFactory = blobCacheFactory;
		this.getSandboxMetaFn = getSandboxMetaFn;
		this.persistSandboxMetaFn = persistSandboxMetaFn;
		this.updateSandboxRuntimeFn = updateSandboxRuntimeFn;
		this.listSandboxesFn = listSandboxesFn;
		const maxPyWaiters = Number(process.env.MAX_PYTHON_QUEUE ?? "100");
		const maxJsWaiters = Number(process.env.MAX_JS_QUEUE ?? "100");
		const pyTimeout = Number(process.env.PYTHON_QUEUE_TIMEOUT_MS ?? "60000");
		const jsTimeout = Number(process.env.JS_QUEUE_TIMEOUT_MS ?? "60000");
		this.pythonSem = {
			limit: maxConcurrentPython ?? Number(process.env.MAX_CONCURRENT_PYTHON ?? "5"),
			maxWaiters: maxPyWaiters,
			waitTimeoutMs: pyTimeout,
			inFlight: 0,
			waiters: [],
		};
		this.jsSem = {
			limit: maxConcurrentJs ?? Number(process.env.MAX_CONCURRENT_JS ?? "5"),
			maxWaiters: maxJsWaiters,
			waitTimeoutMs: jsTimeout,
			inFlight: 0,
			waiters: [],
		};
		this.defenseInDepth = defenseInDepth ?? process.env.JUST_BASH_DEFENSE_IN_DEPTH === "true";
		this.defenseAuditMode = defenseAuditMode ?? process.env.JUST_BASH_DEFENSE_AUDIT_MODE !== "false";
		this.sandboxBaseEnv = buildSandboxBaseEnv();
		this.gitIdentity = buildGitIdentity();
		const workers = workerEnabled ?? process.env.SQL_FS_WORKERS_ENABLED === "true";
		if (workers && (createFs !== undefined || tenantConfig === undefined)) {
			throw new Error("Worker sessions require tenantConfig and the Postgres filesystem factory");
		}
		this.workerPool = workers
			? new WorkerOwnerPool({
					...(workerOptions ?? loadWorkerPoolOptions()),
					defenseInDepth: this.defenseInDepth,
					defenseAuditMode: this.defenseAuditMode,
				})
			: undefined;
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
			blobCache: this.workerPool === undefined ? this.blobCacheFactory?.(tenantId) : undefined,
		};
		this.backends.set(tenantId, backend);
		return backend;
	}

	private async buildFs(
		tenantId: string,
		sandboxId: string,
		owner = "",
		openExisting = false,
	): Promise<{ fs: IFileSystem; resolvedOwner: string; createdAt: string }> {
		if (this.createFsOverride !== undefined) {
			return {
				fs: await this.createFsOverride(tenantId, sandboxId),
				resolvedOwner: owner,
				createdAt: new Date().toISOString(),
			};
		}
		const backend = this.getOrInitBackend(tenantId);
		return createPostgresSandboxFs(
			{
				connectionString: backend.connectionString,
				poolMax: this.postgresPoolMax,
				scriptTxBuffer: this.scriptTxBuffer,
				tenantId,
				blobCache: backend.blobCache,
				openExisting,
			},
			sandboxId,
			owner,
		);
	}

	private estimatePathCacheBytes(fs: IFileSystem): number {
		// F9e: prefer the O(1) incremental counter when the backend maintains one
		// (SqlFs). Its value equals this full-walk exactly, so the budget is
		// identical without re-scanning the whole pathCache on every dirty exec.
		const withCounter = fs as Partial<{ getPathCacheBytes(): number }>;
		if (typeof withCounter.getPathCacheBytes === "function") {
			return withCounter.getPathCacheBytes();
		}
		const paths = fs.getAllPaths();
		let total = 0;
		for (const p of paths) {
			total += p.length + 100;
		}
		return total;
	}

	private createRuntime(
		fs: IFileSystem,
		tenantId: string,
		sandboxId: string,
		runtimeOptions: RuntimeOptions,
	): SessionRuntime {
		return createSessionRuntime(
			fs,
			{ tenantId, sandboxId, runtimeOptions },
			{
				defenseInDepth: this.defenseInDepth,
				defenseAuditMode: this.defenseAuditMode,
				executionLimits: this.executionLimits,
				baseEnv: this.sandboxBaseEnv,
				gitIdentity: this.gitIdentity,
			},
		);
	}

	async getOrCreate(
		tenantId: string,
		sandboxId: string,
		runtimeOptions?: RuntimeOptions,
		owner = "",
		openExisting = false,
	): Promise<Session> {
		assertValidSandboxId(sandboxId);
		if (this.workerPool !== undefined && workerReservation.getStore() === undefined) {
			return this.workerPool.run(tenantId, this.sessionKey(tenantId, sandboxId), false, () =>
				this.getOrCreate(tenantId, sandboxId, runtimeOptions, owner, openExisting),
			);
		}
		if (this.shuttingDown) {
			throw Object.assign(new Error("ESHUTTINGDOWN: server is shutting down"), { code: "ESHUTTINGDOWN" });
		}
		const key = this.sessionKey(tenantId, sandboxId);
		const existing = this.sessions.get(key);
		if (existing !== undefined) {
			try {
				await this.attachWorker(existing);
			} catch (error) {
				if (this.isSandboxMissing(error)) await existing.destroyPromise;
				throw error;
			}
			existing.lastUsed = Date.now();
			return existing;
		}

		const inProgress = this.pending.get(key);
		if (inProgress !== undefined) {
			return inProgress;
		}

		const resolvedRuntime: RuntimeOptions = runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS;

		const creationPromise = (async (): Promise<Session> => {
			let createdFs: IFileSystem | undefined;
			try {
				if (this.workerPool !== undefined) {
					const session = await this.buildWorkerSession(tenantId, sandboxId, resolvedRuntime, owner, openExisting);
					this.sessions.set(key, session);
					return session;
				}
				const {
					fs,
					resolvedOwner,
					createdAt: fsCreatedAt,
				} = await this.buildFs(tenantId, sandboxId, owner, openExisting);
				createdFs = fs;
				const runtime = this.createRuntime(fs, tenantId, sandboxId, resolvedRuntime);
				const pathCacheBytes = this.estimatePathCacheBytes(fs);

				// Shutdown may have begun while buildFs() was running. If so, refuse
				// to register the session — shutdown's snapshot has already been
				// taken and would never see this fs, leaking its dialect pool.
				if (this.shuttingDown) {
					throw Object.assign(new Error("ESHUTTINGDOWN: server is shutting down"), { code: "ESHUTTINGDOWN" });
				}
				const session: Session = {
					...runtime,
					lastUsed: Date.now(),
					inFlight: 0,
					lock: new RWLock(),
					state: "active",
					owner: resolvedOwner,
					name: null,
					createdAt: fsCreatedAt,
					pathCacheBytes,
					overBudget: pathCacheBytes > this.pathCacheMaxBytes,
				};
				this.sessions.set(key, session);
				createdFs = undefined; // ownership transferred to session
				return session;
			} catch (err) {
				if (createdFs !== undefined) {
					try {
						await this.disconnectFs(createdFs);
					} catch {
						// best-effort
					}
				}
				throw err;
			} finally {
				this.pending.delete(key);
			}
		})();

		this.pending.set(key, creationPromise);
		return creationPromise;
	}

	private async buildWorkerSession(
		tenantId: string,
		sandboxId: string,
		runtimeOptions: RuntimeOptions,
		owner: string,
		openExisting: boolean,
	): Promise<Session> {
		const pool = this.workerPool;
		if (pool === undefined) throw new Error("worker pool is disabled");
		const key = this.sessionKey(tenantId, sandboxId);
		const metadata = await pool.attach({
			tenantId,
			sandboxId,
			runtimeOptions,
			owner,
			connectionString: this.getOrInitBackend(tenantId).connectionString,
			cwd: "/home/user",
			openExisting,
		});
		const fs = new WorkerFileSystem(pool, key);
		const session: Session = {
			fs,
			bash: {
				exec: (script, options) => this.execWithRuntimeThrottle(session, script, options),
				getCwd: () => session.cwd,
				registerCommand: () => {
					throw new Error("Worker commands must be registered by the worker runtime factory");
				},
			},
			runtimeOptions,
			tenantId,
			sandboxId,
			scriptTx: new WorkerScriptScope(fs),
			lastUsed: Date.now(),
			inFlight: 0,
			lock: new RWLock(),
			state: "active",
			owner: metadata.owner,
			name: null,
			createdAt: metadata.createdAt,
			pathCacheBytes: metadata.pathCacheBytes,
			overBudget: metadata.pathCacheBytes > this.pathCacheMaxBytes,
			cwd: metadata.cwd,
		};
		return session;
	}

	private async attachWorker(session: Session): Promise<void> {
		if (this.workerPool === undefined || !(session.fs instanceof WorkerFileSystem)) return;
		try {
			await this.workerPool.attach({
				tenantId: session.tenantId,
				sandboxId: session.sandboxId,
				connectionString: this.getOrInitBackend(session.tenantId).connectionString,
				runtimeOptions: session.runtimeOptions,
				owner: session.owner,
				cwd: session.cwd,
				openExisting: true,
			});
		} catch (error) {
			if (!this.isSandboxMissing(error)) throw error;
			this.evictMissingSandbox(session.tenantId, session.sandboxId, session);
			throw createEnoent(`/${session.sandboxId}`);
		}
	}

	private isSandboxMissing(error: unknown): boolean {
		const code = (error as { code?: string } | null)?.code;
		return code === "ENOENT" || code === "ESANDBOXGONE";
	}

	private evictMissingSandbox(tenantId: string, sandboxId: string, session: Session): void {
		if (session.destroyPromise !== undefined) return;
		session.state = "closing";
		const key = this.sessionKey(tenantId, sandboxId);
		session.destroyPromise = session.lock.runExclusive(async () => {
			try {
				await this.disconnectFs(session.fs);
			} finally {
				if (this.sessions.get(key) === session) this.sessions.delete(key);
			}
		});
	}

	async getSessionPaths(session: Session): Promise<string[]> {
		return session.fs instanceof WorkerFileSystem ? session.fs.getPaths() : session.fs.getAllPaths();
	}

	assertWorkerMessageBudget(value: unknown, additionalBytes = 0): void {
		if (this.workerPool !== undefined) {
			assertWorkerMessageBudget(
				value,
				this.workerPool.options.executionLimits.maxWorkerMessageBytes ?? 64 * 1024 * 1024,
				additionalBytes,
			);
		}
	}

	getWorkerMetrics() {
		if (this.workerPool === undefined) return undefined;
		return {
			...this.workerPool.metrics,
			pythonActive: this.pythonSem.inFlight,
			pythonQueued: this.pythonSem.waiters.length,
			javascriptActive: this.jsSem.inFlight,
			javascriptQueued: this.jsSem.waiters.length,
		};
	}

	async initializeWorkers(): Promise<void> {
		await this.workerPool?.start();
	}

	async crashWorkerForTest(tenantId: string, sandboxId: string): Promise<void> {
		await this.workerPool?.crashWorkerForTest(this.sessionKey(tenantId, sandboxId));
	}

	private withWorkerAdmission<T>(
		tenantId: string,
		sandboxId: string,
		shared: boolean,
		fn: () => Promise<T>,
	): Promise<T> {
		return this.workerPool === undefined
			? fn()
			: this.workerPool.run(tenantId, this.sessionKey(tenantId, sandboxId), shared, fn);
	}

	private async recoverWorker(err: unknown): Promise<void> {
		if (
			this.workerPool === undefined ||
			!["EEXEC_OUTCOME_UNKNOWN", "EWORKER_UNAVAILABLE"].includes((err as { code?: string } | null)?.code ?? "")
		)
			return;
		const pool = this.workerPool;
		const reservation = workerReservation.getStore();
		if (reservation === undefined) return;
		const previous = this.workerRecoveries.get(reservation);
		if (previous?.generation === reservation.slot.generation) return previous.task;
		const task = (async () => {
			const identity = await pool.recover((err as { code?: string }).code === "EEXEC_OUTCOME_UNKNOWN");
			if (identity !== undefined) {
				await retirePostgresSandboxGeneration(identity.connectionString, identity.sandboxId);
			}
		})();
		this.workerRecoveries.set(reservation, { generation: reservation.slot.generation, task });
		await task;
	}

	private async lostWorkerOutcome(error?: unknown): Promise<void> {
		const reservation = workerReservation.getStore();
		if (
			reservation === undefined ||
			(!reservation.execDispatched && !reservation.committedFsWrite && !reservation.creatingAttachDispatched)
		)
			return;
		const unknown = new OutcomeUnknownError();
		try {
			await this.recoverWorker(unknown);
		} catch {}
		throw preservesAmbiguousOutcome(error) ? error : unknown;
	}

	private async withWorkerLease<T>(fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return sessionLeaseContext.run({ lostSignal: signal }, async () => {
			const reservation = workerReservation.getStore();
			if (reservation === undefined) return fn(signal);
			reservation.lostSignal = signal;
			let result: T;
			try {
				result = await fn(signal);
			} catch (error) {
				const code = (error as { code?: string } | null)?.code;
				if (signal?.aborted || code === "ELOCKLOST") await this.lostWorkerOutcome(error);
				if (code === "ERUNTIME_BUSY" && (reservation.execDispatched || reservation.committedFsWrite)) {
					throw new OutcomeUnknownError(
						"EEXEC_OUTCOME_UNKNOWN: an earlier operation in this request may have applied; do not replay the request",
					);
				}
				throw error;
			}
			if (signal?.aborted) await this.lostWorkerOutcome();
			return result;
		});
	}

	getSession(tenantId: string, sandboxId: string): Session | undefined {
		return this.sessions.get(this.sessionKey(tenantId, sandboxId));
	}

	private async withExecLockExclusive<T>(
		tenantId: string,
		sandboxId: string,
		fn: (lostSignal?: AbortSignal) => Promise<T>,
	): Promise<T> {
		assertValidSandboxId(sandboxId);
		if (this.workerPool !== undefined && workerReservation.getStore()?.key !== this.sessionKey(tenantId, sandboxId)) {
			return this.withWorkerAdmission(tenantId, sandboxId, false, () =>
				this.withExecLockExclusive(tenantId, sandboxId, fn),
			);
		}
		if (this.redis === undefined) return this.withWorkerLease(fn);
		const guarded = (signal: AbortSignal) => this.withWorkerLease(fn, signal);
		const options = { ...this.execLockOptions, onLostAfterWork: () => this.lostWorkerOutcome() };
		if (!this.rwlockEnabled) {
			return withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), guarded, options);
		}
		return withDistributedRWLock(this.redis, rwLockKeys(tenantId, sandboxId), "exclusive", guarded, options);
	}

	private async withExecLockShared<T>(
		tenantId: string,
		sandboxId: string,
		fn: (lostSignal?: AbortSignal) => Promise<T>,
	): Promise<T> {
		assertValidSandboxId(sandboxId);
		if (this.workerPool !== undefined && workerReservation.getStore()?.key !== this.sessionKey(tenantId, sandboxId)) {
			return this.withWorkerAdmission(tenantId, sandboxId, true, () =>
				this.withExecLockShared(tenantId, sandboxId, fn),
			);
		}
		if (this.redis === undefined) return this.withWorkerLease(fn);
		const guarded = (signal: AbortSignal) => this.withWorkerLease(fn, signal);
		const options = { ...this.execLockOptions, onLostAfterWork: () => this.lostWorkerOutcome() };
		// Flag-off (rolling deploy): the distributed RW lock keyspace is disabled,
		// so readers fall back to the SAME legacy single-key SET-NX lock that
		// flag-off writers take (`withExecLockExclusive`). This serializes reads
		// against writers — cross-replica AND same-replica — preventing a reader's
		// `ensureFreshCache` → `reload()` from clobbering a writer's uncommitted
		// in-memory cache mid-script (F4). It is intentionally less parallel than
		// the RW lock; flag-off is a transient deploy state.
		if (!this.rwlockEnabled) {
			// readOnly: the shared entry points run under a read-only scope, so a
			// lease lost after `fn` returned still means "nothing applied" (#175 M1).
			return withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), guarded, {
				...options,
				readOnly: true,
			});
		}
		return withDistributedRWLock(this.redis, rwLockKeys(tenantId, sandboxId), "shared", guarded, options);
	}

	/** Shared entry logic for all exclusive (write) session wrappers. */
	private async withSessionEntry<T>(
		tenantId: string,
		sandboxId: string,
		session: Session,
		fn: (session: Session) => Promise<T>,
		lostSignal?: AbortSignal,
	): Promise<T> {
		if (session.state === "closing") {
			throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
		}

		try {
			return await session.lock.runExclusive(async () => {
				if (session.state === "closing")
					throw Object.assign(new Error("Session is shutting down"), { code: "ESESSIONCLOSING" });
				session.inFlight++;
				session.lastUsed = Date.now();
				let primaryError: unknown;
				let failed = false;
				let result: T | undefined;
				try {
					await this.attachWorker(session);
					const reservation = workerReservation.getStore();
					if (reservation !== undefined) {
						reservation.lostSignal = lostSignal;
						reservation.phase = "running";
					}
					await this.ensureFreshCache(tenantId, sandboxId, session);
					result = await fn(session);
					if (asCoherentFs(session.fs)?.poisoned()) {
						throw Object.assign(
							new Error("ECOHERENCE_UNAPPLIED: recovery failed; nothing was applied, retry is safe"),
							{ code: "ECOHERENCE_UNAPPLIED" },
						);
					}
				} catch (error) {
					primaryError = error;
					failed = true;
					try {
						await this.recoverWorker(error);
					} catch {}
				}
				try {
					const coherent = asCoherentFs(session.fs);
					if (coherent === undefined || coherent.wasDirty()) {
						session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
						session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
						await coherent?.clearDirty();
					}
				} catch (error) {
					if (!failed) {
						try {
							await this.recoverWorker(error);
						} catch {}
						primaryError = error;
						failed = true;
					}
				} finally {
					session.inFlight--;
				}
				if (failed) throw primaryError;
				return result as T;
			});
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") await session.destroyPromise;
			throw error;
		}
	}

	/**
	 * Inner entry logic for the readOnly path. Called from within the
	 * distributed shared lock held by `withSessionRead`. Holds the per-session
	 * RWLock in shared mode so multiple readers run in parallel, and skips
	 * script-tx (no writes are permitted). The session FS is put into
	 * read-only scope before fn runs and restored on exit so any mutating
	 * syscall throws EREADONLY.
	 */
	private async withSessionReadEntry<T>(
		tenantId: string,
		sandboxId: string,
		session: Session,
		fn: (session: Session) => Promise<T>,
		lostSignal?: AbortSignal,
	): Promise<T> {
		if (session.state === "closing") {
			throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
		}

		try {
			return await session.lock.runShared(async () => {
				if (session.state === "closing") {
					throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
				}
				const roFs = asReadOnlyFs(session.fs);
				const ctx: ReadOnlyContext = { violated: false };

				session.inFlight++;
				session.lastUsed = Date.now();
				try {
					await this.attachWorker(session);
					const reservation = workerReservation.getStore();
					if (reservation !== undefined) {
						reservation.lostSignal = lostSignal;
						reservation.phase = "running";
					}
					await this.ensureFreshCache(tenantId, sandboxId, session);
				} catch (error) {
					session.inFlight--;
					throw error;
				}
				let scopeOpened = false;
				try {
					if (roFs !== undefined) {
						roFs.beginReadOnlyScope();
						scopeOpened = true;
					}
					// `readOnlyContext.run` propagates `ctx` down the async stack into
					// `bash.exec` → `SqlFs.#assertWritable`, which marks *this* call's
					// context (not a shared FS flag). Innocent concurrent readers keep
					// their own `ctx.violated === false`.
					let result: T;
					try {
						result = await readOnlyContext.run(ctx, () => fn(session));
					} catch (err) {
						try {
							await this.recoverWorker(err);
						} catch {}
						const errCode = (err as Error & { code?: string }).code;
						// Audit the violation even when an unrelated error (e.g. AbortError
						// from a timeout) wins as the thrown error. Bash can record an
						// EREADONLY rejection mid-script (ctx.violated=true) and later
						// throw for an unrelated reason; the security event must still
						// surface to monitoring.
						if (ctx.violated || errCode === "EREADONLY") {
							logAudit("read_only_violation", { tenantId, sandboxId });
						}
						// Some bash builtins (e.g. shell redirections `echo x > f`) let
						// the raw EREADONLY rejection escape bash.exec instead of
						// normalising it to a non-zero exit. Remap to EREADONLY_VIOLATION
						// so the route layer sees a single uniform code regardless of
						// whether the violation surfaced via ctx-tagging (script ran to
						// completion with a non-zero exit) or as a thrown rejection.
						if (errCode === "EREADONLY") {
							throw Object.assign(
								new Error("EREADONLY_VIOLATION: readOnly script attempted to mutate the filesystem"),
								{
									code: "EREADONLY_VIOLATION",
								},
							);
						}
						// Unrelated error wins; the violation was already audited above.
						throw err;
					}
					if (ctx.violated) {
						logAudit("read_only_violation", { tenantId, sandboxId });
						// Audit M11: a readOnly batch shares one violation context, so a
						// single mutating script fails the WHOLE batch (and its sibling
						// reads are discarded). This is intentional fail-CLOSED behaviour —
						// the read-only safety net must reject the request as a unit and
						// guarantee nothing persisted; surfacing partial results from a
						// batch that contained a rejected mutation would be a footgun.
						throw Object.assign(new Error("EREADONLY_VIOLATION: readOnly script attempted to mutate the filesystem"), {
							code: "EREADONLY_VIOLATION",
						});
					}
					return result;
				} finally {
					if (scopeOpened && roFs !== undefined) {
						try {
							roFs.endReadOnlyScope();
						} catch (err) {
							// Scope toggle must not mask the primary error; log and continue.
							console.error(
								JSON.stringify({
									event: "end_read_only_scope_error",
									tenantId,
									sandboxId,
									error: (err as Error).message,
								}),
							);
						}
					}
					session.inFlight--;
				}
			});
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") await session.destroyPromise;
			throw error;
		}
	}

	private async syncRuntime(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		const meta = await this.getSandboxMetaFn?.(tenantId, sandboxId);
		if (!meta) return;
		const { python, javascript, network } = meta;
		const current = session.runtimeOptions;
		if (python === current.python && javascript === current.javascript && network === current.network) return;
		const runtimeOptions = { python, javascript, network };
		if (session.fs instanceof WorkerFileSystem) await session.fs.call({ kind: "runtime", runtimeOptions });
		else session.bash = this.createRuntime(session.fs, tenantId, sandboxId, runtimeOptions).bash;
		session.runtimeOptions = runtimeOptions;
	}

	/** Takes the locked session so no script runs across the change. */
	async updateSandboxRuntime(session: Session, runtime: Partial<RuntimeOptions>): Promise<SandboxMeta> {
		if (this.updateSandboxRuntimeFn === undefined) {
			throw Object.assign(new Error("updateSandboxRuntime not configured"), { code: "ENOTSUP" });
		}
		const meta = await this.updateSandboxRuntimeFn(session.tenantId, session.sandboxId, runtime);
		if (meta === null) throw createEnoent(`/${session.sandboxId}`);
		return meta;
	}

	private async ensureFreshCache(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		const coherent = asCoherentFs(session.fs);
		if (coherent === undefined) return;
		try {
			const claimed = !(session.fs instanceof WorkerFileSystem) && (await coherent.claimGeneration?.()) === true;
			if ((await coherent.ensureFresh()) || claimed) await this.syncRuntime(tenantId, sandboxId, session);
			session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
			session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
			if (session.state === "closing")
				throw Object.assign(new Error("Session is shutting down"), { code: "ESESSIONCLOSING" });
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code !== "ENOENT" && code !== "ESANDBOXGONE") {
				if (session.state === "closing") {
					throw Object.assign(new Error("Session is shutting down"), { code: "ESESSIONCLOSING" });
				}
				throw error;
			}
			this.evictMissingSandbox(tenantId, sandboxId, session);
			throw createEnoent(`/${sandboxId}`);
		}
	}

	async withSession<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
		owner = "",
	): Promise<T> {
		return this.withExecLockExclusive(tenantId, sandboxId, async (lostSignal) => {
			const session = await this.getOrCreate(tenantId, sandboxId, runtimeOptions, owner);
			return this.withSessionEntry(tenantId, sandboxId, session, fn, lostSignal);
		});
	}

	async withExistingSession<T>(tenantId: string, sandboxId: string, fn: (session: Session) => Promise<T>): Promise<T> {
		return this.withExecLockExclusive(tenantId, sandboxId, async (lostSignal) => {
			const session = this.sessions.get(this.sessionKey(tenantId, sandboxId));
			if (session === undefined) {
				throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
			}
			return this.withSessionEntry(tenantId, sandboxId, session, fn, lostSignal);
		});
	}

	/**
	 * readOnly entry point. Acquires the distributed shared exec lock (so readers
	 * across replicas run in parallel while writers are excluded), then the
	 * per-session RWLock in shared mode, and activates a read-only scope on the
	 * session FS so any mutating syscall throws EREADONLY.
	 *
	 * Falls back to Postgres rehydrate (like withSessionOrRehydrate) when the
	 * session was evicted from the in-memory pool but the sandbox still
	 * exists in the persistent store.
	 */
	async withSessionRead<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
	): Promise<T> {
		return this.withExecLockShared(tenantId, sandboxId, async (lostSignal) => {
			const session = this.sessions.get(this.sessionKey(tenantId, sandboxId));
			if (session !== undefined && session.state !== "closing") {
				return this.withSessionReadEntry(tenantId, sandboxId, session, fn, lostSignal);
			}
			return this.rehydrateAndExecRead(tenantId, sandboxId, fn, runtimeOptions, lostSignal);
		});
	}

	private async rehydrateAndExecRead<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
		lostSignal?: AbortSignal,
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
			? { python: meta.python, javascript: meta.javascript, network: meta.network }
			: (runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS);
		const session = await this.getOrCreate(tenantId, sandboxId, resolvedRuntime, meta?.owner ?? "", true);
		if (meta?.owner) session.owner = meta.owner;
		if (meta?.name !== undefined) session.name = meta.name;
		if (meta?.createdAt !== undefined) session.createdAt = meta.createdAt;
		return this.withSessionReadEntry(tenantId, sandboxId, session, fn, lostSignal);
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
		return this.withExecLockExclusive(tenantId, sandboxId, async (lostSignal) => {
			const session = this.sessions.get(this.sessionKey(tenantId, sandboxId));
			if (session !== undefined && session.state !== "closing") {
				return this.withSessionEntry(tenantId, sandboxId, session, fn, lostSignal);
			}
			return this.rehydrateAndExec(tenantId, sandboxId, fn, runtimeOptions, lostSignal);
		});
	}

	private async rehydrateAndExec<T>(
		tenantId: string,
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
		lostSignal?: AbortSignal,
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
			? { python: meta.python, javascript: meta.javascript, network: meta.network }
			: (runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS);
		const session = await this.getOrCreate(tenantId, sandboxId, resolvedRuntime, meta?.owner ?? "", true);
		if (meta?.owner) {
			session.owner = meta.owner;
		}
		if (meta?.name !== undefined) {
			session.name = meta.name;
		}
		if (meta?.createdAt !== undefined) {
			session.createdAt = meta.createdAt;
		}
		return this.withSessionEntry(tenantId, sandboxId, session, fn, lostSignal);
	}

	async persistSandboxMeta(tenantId: string, sandboxId: string, meta: SandboxMeta): Promise<void> {
		if (this.persistSandboxMetaFn !== undefined) {
			await this.persistSandboxMetaFn(tenantId, sandboxId, meta);
		}
	}

	/**
	 * Returns persisted metadata for the given sandbox from the DB, or null if
	 * the sandbox does not exist or no DB is configured.
	 */
	async getSandboxMeta(tenantId: string, sandboxId: string): Promise<SandboxMeta | null> {
		if (!isValidSandboxId(sandboxId)) return null;
		if (this.getSandboxMetaFn === undefined) return null;
		return this.getSandboxMetaFn(tenantId, sandboxId);
	}

	async listSandboxes(tenantId: string, owner?: string): Promise<SandboxListEntry[]> {
		if (this.listSandboxesFn === undefined) {
			throw Object.assign(new Error("listSandboxes not configured"), { code: "ENOTSUP" });
		}
		return this.listSandboxesFn(tenantId, owner);
	}

	async destroy(tenantId: string, sandboxId: string): Promise<boolean> {
		return this.withExecLockExclusive(tenantId, sandboxId, async () => {
			const key = this.sessionKey(tenantId, sandboxId);
			const session = this.sessions.get(key);
			if (session === undefined) {
				await this.destroySandboxFn(tenantId, sandboxId);
				return false;
			}
			if (session.destroyPromise !== undefined) {
				await session.destroyPromise;
				return true;
			}
			session.state = "closing";
			session.destroyPromise = session.lock.runExclusive(async () => {
				this.sessions.delete(key);
				try {
					await this.destroySandboxFn(tenantId, sandboxId);
				} finally {
					await this.disconnectFs(session.fs);
				}
			});
			await session.destroyPromise;
			return true;
		});
	}

	startReaper(intervalMs = 60_000): void {
		if (this.reaperTimer !== undefined) return;
		this.reaperTimer = setInterval(() => this.runReaper(), intervalMs);
		if (typeof this.reaperTimer.unref === "function") this.reaperTimer.unref();
	}

	/**
	 * Graceful shutdown: stops the reaper, marks every session as closing,
	 * waits (up to a bound) for in-flight work, and disconnects every live
	 * filesystem so dialect connection pools don't leak.
	 *
	 * Safe to call multiple times.
	 */
	async shutdown(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.stopReaper();

		const drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
		const deadline = Date.now() + drainTimeoutMs;
		await this.workerPool?.shutdown(Math.max(0, deadline - Date.now()));

		// Mark every session closing so new entries reject early.
		for (const session of this.sessions.values()) {
			session.state = "closing";
		}

		// Reject any queued runtime semaphore waiters: they would otherwise
		// hold their request closures alive past shutdown.
		for (const sem of [this.pythonSem, this.jsSem]) {
			while (sem.waiters.length > 0) {
				const w = sem.waiters.shift();
				if (w === undefined) break;
				w.reject(new RuntimeBackpressureError("shutting_down"));
			}
		}

		const sessionsSnapshot = [...this.sessions.entries()];
		await Promise.allSettled(
			sessionsSnapshot.map(async ([key, session]) => {
				const remaining = Math.max(0, deadline - Date.now());
				if (session.destroyPromise !== undefined) {
					await Promise.race([session.destroyPromise, new Promise<void>((resolve) => setTimeout(resolve, remaining))]);
					return;
				}
				try {
					await Promise.race([
						session.lock.runExclusive(async () => {
							/* drain */
						}),
						new Promise<void>((resolve) => setTimeout(resolve, remaining)),
					]);
				} catch {
					// best-effort
				}
				this.sessions.delete(key);
				try {
					await this.disconnectFs(session.fs);
				} catch {
					// best-effort
				}
			}),
		);
		this.sessions.clear();
	}

	/** Alias for shutdown() — matches the plan's `closeAll()` naming. */
	async closeAll(opts?: { drainTimeoutMs?: number }): Promise<void> {
		return this.shutdown(opts);
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
				// Mark closing FIRST so any request that already captured this
				// session reference but hasn't yet entered the mutex will
				// observe ESESSIONCLOSING in withSessionEntry instead of running
				// against a disconnected filesystem.
				session.state = "closing";
				this.sessions.delete(key);
				void session.lock.runExclusive(() => this.disconnectFs(session.fs));
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

	private acquireSlot(sem: Semaphore, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" }));
		}
		if (sem.inFlight < sem.limit) {
			sem.inFlight++;
			return Promise.resolve();
		}
		if (sem.waiters.length >= sem.maxWaiters) {
			return Promise.reject(new RuntimeBackpressureError("queue_full"));
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: SemaphoreWaiter = {
				resolve: () => {
					if (waiter.settled) return;
					waiter.settled = true;
					if (waiter.timer !== undefined) clearTimeout(waiter.timer);
					if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
						waiter.signal.removeEventListener("abort", waiter.onAbort);
					}
					resolve();
				},
				reject: (err: Error) => {
					if (waiter.settled) return;
					waiter.settled = true;
					if (waiter.timer !== undefined) clearTimeout(waiter.timer);
					if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
						waiter.signal.removeEventListener("abort", waiter.onAbort);
					}
					// Remove from queue so the closure doesn't outlive the request.
					const idx = sem.waiters.indexOf(waiter);
					if (idx >= 0) sem.waiters.splice(idx, 1);
					reject(err);
				},
				timer: undefined,
				onAbort: undefined,
				signal,
				settled: false,
			};
			(waiter as { timer: ReturnType<typeof setTimeout> }).timer = setTimeout(
				() => waiter.reject(new RuntimeBackpressureError("wait_timeout")),
				sem.waitTimeoutMs,
			);
			if (signal !== undefined) {
				const onAbort = (): void =>
					waiter.reject(Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" }));
				(waiter as { onAbort: () => void }).onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			sem.waiters.push(waiter);
		});
	}

	private releaseSlot(sem: Semaphore): void {
		// Skip waiters that already settled (aborted/timed out) but haven't
		// been spliced — defensive belt-and-braces.
		while (sem.waiters.length > 0) {
			const next = sem.waiters.shift();
			if (next === undefined) break;
			if (next.settled) continue;
			next.resolve();
			return;
		}
		sem.inFlight--;
	}

	async execWithRuntimeThrottle(session: Session, script: string, opts?: ExecOptions): Promise<BashExecResult> {
		try {
			return await this.execOnRuntime(session, script, opts);
		} catch (err) {
			const escaped = execFsError(err);
			if (escaped === undefined) throw err;
			console.error(
				JSON.stringify({
					event: "exec_fs_error",
					tenantId: session.tenantId,
					sandboxId: session.sandboxId,
					code: extractErrCode(err),
					error: (err as Error).message,
				}),
			);
			throw escaped;
		}
	}

	private async execOnRuntime(session: Session, script: string, opts?: ExecOptions): Promise<BashExecResult> {
		if (session.fs instanceof WorkerFileSystem && this.workerPool !== undefined) {
			const pool = this.workerPool;
			const fs = session.fs;
			return this.withRuntimeSlots(session, opts?.signal, async () => {
				const { signal, ...options } = opts ?? {};
				const result = await pool.send<BashExecResult>(
					{ kind: "exec", script, options: { ...options, cwd: options.cwd ?? session.cwd } },
					signal,
				);
				const metadata = pool.metadata;
				if (metadata !== undefined) session.cwd = metadata.cwd;
				fs.refreshMetadata();
				return result;
			});
		}

		return this.withRuntimeSlots(session, opts?.signal, () => executeSessionRuntime(session, script, opts));
	}

	private async withRuntimeSlots<T>(
		session: Session,
		signal: AbortSignal | undefined,
		fn: () => Promise<T>,
	): Promise<T> {
		const usesPython = session.runtimeOptions.python;
		const usesJs = session.runtimeOptions.javascript;
		if (!usesPython && !usesJs) return fn();
		if (usesPython) await this.acquireSlot(this.pythonSem, signal);
		if (usesJs) {
			try {
				await this.acquireSlot(this.jsSem, signal);
			} catch (e) {
				if (usesPython) this.releaseSlot(this.pythonSem);
				throw e;
			}
		}

		try {
			return await fn();
		} finally {
			if (usesJs) this.releaseSlot(this.jsSem);
			if (usesPython) this.releaseSlot(this.pythonSem);
		}
	}
}
