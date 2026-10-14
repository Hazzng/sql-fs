import type { Redis } from "ioredis";
import type { BashExecResult, ExecOptions, IFileSystem } from "just-bash";
import { createEnoent } from "../sql-fs/errors.js";
import type { ICoherentFs, IReadOnlyScopeFs } from "../sql-fs/sql-fs.js";
import type { SandboxListEntry, SandboxMeta } from "../sql-fs/types.js";
import type { GitIdentity } from "./commands/git-command.js";
import { execLockKey, withDistributedLock } from "./distributed-lock.js";
import { type DistributedRWLockOptions, rwLockKeys, withDistributedRWLock } from "./distributed-rw-lock.js";
import { execFsError, extractErrCode } from "./errors.js";
import { logAudit } from "./lib/audit.js";
// NOTE: `py-exec` (warm host Python) is intentionally NOT imported/wired here.
// It spawned the HOST python3 with full `process.env`, which is a sandbox
// escape (RCE + secret/credential exfil — audit C1). The WASM `python3`
// command from just-bash (enabled via `python: true` below) is the safe path.
import { type ReadOnlyContext, readOnlyContext } from "./read-only-context.js";
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

import { RuntimeAdmission, type RuntimeAdmissionOptions } from "./session-manager/runtime-admission.js";
import {
	type Session,
	SessionCatalog,
	type SessionCatalogOptions,
	type SessionSource,
	sessionKey,
} from "./session-manager/session-catalog.js";
import { TenantBackends, type TenantBackendsOptions } from "./session-manager/tenant-backends.js";
export { RuntimeBackpressureError } from "./session-manager/runtime-admission.js";
export type { Session } from "./session-manager/session-catalog.js";

import { WorkerFileSystem, WorkerScriptScope } from "./worker-owner/filesystem.js";
import { assertWorkerMessageBudget } from "./worker-owner/message-budget.js";
import { WorkerOwnerPool, type WorkerPoolOptions, loadWorkerPoolOptions } from "./worker-owner/pool.js";
import type { ShellExecutionLimits } from "./worker-owner/protocol.js";

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

export interface SessionManagerOptions extends TenantBackendsOptions, SessionCatalogOptions, RuntimeAdmissionOptions {
	readonly workerEnabled?: boolean;
	readonly executionLimits?: ShellExecutionLimits;
	readonly workerOptions?: WorkerPoolOptions;
	readonly redis?: Redis;
	readonly execLockOptions?: Partial<DistributedRWLockOptions>;
	/** Disable during rolling deploys that still use the legacy exclusive lock. */
	readonly rwlockEnabled?: boolean;
	readonly defenseInDepth?: boolean;
	readonly defenseAuditMode?: boolean;
}

export class SessionManager {
	private readonly catalog: SessionCatalog;
	private readonly backends: TenantBackends;
	private readonly runtimeAdmission: RuntimeAdmission;
	private readonly redis: Redis | undefined;
	private readonly execLockOptions: Partial<DistributedRWLockOptions> | undefined;
	private readonly rwlockEnabled: boolean;
	private readonly defenseInDepth: boolean;
	private readonly defenseAuditMode: boolean;
	private readonly sandboxBaseEnv: Record<string, string>;
	private readonly gitIdentity: GitIdentity | undefined;
	private readonly workerPool: WorkerOwnerPool | undefined;
	private readonly executionLimits: ShellExecutionLimits | undefined;

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
		this.executionLimits = executionLimits;
		this.redis = redis;
		this.execLockOptions = execLockOptions;
		this.rwlockEnabled = rwlockEnabled ?? true;
		this.catalog = new SessionCatalog({ idleMs, pathCacheMaxBytes });
		this.runtimeAdmission = new RuntimeAdmission({ maxConcurrentPython, maxConcurrentJs });
		this.defenseInDepth = defenseInDepth ?? process.env.JUST_BASH_DEFENSE_IN_DEPTH === "true";
		this.defenseAuditMode = defenseAuditMode ?? process.env.JUST_BASH_DEFENSE_AUDIT_MODE !== "false";
		this.sandboxBaseEnv = buildSandboxBaseEnv();
		this.gitIdentity = buildGitIdentity();
		const workers = workerEnabled ?? process.env.SQL_FS_WORKERS_ENABLED === "true";
		this.backends = new TenantBackends(
			{
				tenantConfig,
				createFs,
				destroySandboxFn,
				blobCacheFactory,
				getSandboxMetaFn,
				persistSandboxMetaFn,
				updateSandboxRuntimeFn,
				listSandboxesFn,
				postgresPoolMax,
				scriptTxBuffer,
			},
			workers,
		);
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
		if (this.workerPool !== undefined && !this.workerPool.hasReservation()) {
			return this.workerPool.run(tenantId, sessionKey(tenantId, sandboxId), false, () =>
				this.getOrCreate(tenantId, sandboxId, runtimeOptions, owner, openExisting),
			);
		}
		const resolvedRuntime = runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS;
		return this.catalog.getOrCreate(
			tenantId,
			sandboxId,
			async () => {
				if (this.workerPool !== undefined) {
					return this.buildWorkerSource(tenantId, sandboxId, resolvedRuntime, owner, openExisting);
				}
				const { fs, resolvedOwner, createdAt } = await this.backends.createFs(tenantId, sandboxId, owner, openExisting);
				return {
					fs,
					owner: resolvedOwner,
					createdAt,
					createRuntime: () => this.createRuntime(fs, tenantId, sandboxId, resolvedRuntime),
				};
			},
			(session) => this.attachWorker(session),
		);
	}

	private async buildWorkerSource(
		tenantId: string,
		sandboxId: string,
		runtimeOptions: RuntimeOptions,
		owner: string,
		openExisting: boolean,
	): Promise<SessionSource> {
		const pool = this.workerPool;
		if (pool === undefined) throw new Error("worker pool is disabled");
		const key = sessionKey(tenantId, sandboxId);
		const metadata = await pool.attach({
			tenantId,
			sandboxId,
			runtimeOptions,
			owner,
			connectionString: this.backends.connectionString(tenantId),
			cwd: "/home/user",
			openExisting,
		});
		const fs = new WorkerFileSystem(pool, key);
		const runtime: SessionRuntime = {
			fs,
			bash: {
				exec: (script, options) => this.execWithRuntimeThrottle(runtime, script, options),
				getCwd: () => runtime.cwd,
				registerCommand: () => {
					throw new Error("Worker commands must be registered by the worker runtime factory");
				},
			},
			runtimeOptions,
			tenantId,
			sandboxId,
			scriptTx: new WorkerScriptScope(fs),
			cwd: metadata.cwd,
		};
		return {
			fs,
			owner: metadata.owner,
			createdAt: metadata.createdAt,
			pathCacheBytes: metadata.pathCacheBytes,
			createRuntime: () => runtime,
		};
	}

	private async attachWorker(session: Session): Promise<void> {
		if (this.workerPool === undefined || !(session.fs instanceof WorkerFileSystem)) return;
		try {
			await this.workerPool.attach({
				tenantId: session.tenantId,
				sandboxId: session.sandboxId,
				connectionString: this.backends.connectionString(session.tenantId),
				runtimeOptions: session.runtimeOptions,
				owner: session.owner,
				cwd: session.cwd,
				openExisting: true,
			});
		} catch (error) {
			if (!this.isSandboxMissing(error)) throw error;
			this.catalog.closeMissing(session);
			throw createEnoent(`/${session.sandboxId}`);
		}
	}

	private isSandboxMissing(error: unknown): boolean {
		const code = (error as { code?: string } | null)?.code;
		return code === "ENOENT" || code === "ESANDBOXGONE";
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

	getWorkerMetrics(): (WorkerOwnerPool["metrics"] & RuntimeAdmission["metrics"]) | undefined {
		if (this.workerPool === undefined) return undefined;
		return {
			...this.workerPool.metrics,
			...this.runtimeAdmission.metrics,
		};
	}

	async initializeWorkers(): Promise<void> {
		await this.workerPool?.start();
	}

	async crashWorkerForTest(tenantId: string, sandboxId: string): Promise<void> {
		await this.workerPool?.crashWorkerForTest(sessionKey(tenantId, sandboxId));
	}

	private withWorkerAdmission<T>(
		tenantId: string,
		sandboxId: string,
		shared: boolean,
		fn: () => Promise<T>,
	): Promise<T> {
		return this.workerPool === undefined
			? fn()
			: this.workerPool.run(tenantId, sessionKey(tenantId, sandboxId), shared, fn);
	}

	private withWorkerLease<T>(fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return sessionLeaseContext.run({ lostSignal: signal }, () =>
			this.workerPool === undefined ? fn(signal) : this.workerPool.withLease(signal, fn),
		);
	}

	getSession(tenantId: string, sandboxId: string): Session | undefined {
		return this.catalog.get(tenantId, sandboxId);
	}

	private async withExecLockExclusive<T>(
		tenantId: string,
		sandboxId: string,
		fn: (lostSignal?: AbortSignal) => Promise<T>,
	): Promise<T> {
		assertValidSandboxId(sandboxId);
		if (this.workerPool !== undefined && !this.workerPool.hasReservation(sessionKey(tenantId, sandboxId))) {
			return this.withWorkerAdmission(tenantId, sandboxId, false, () =>
				this.withExecLockExclusive(tenantId, sandboxId, fn),
			);
		}
		if (this.redis === undefined) return this.withWorkerLease(fn);
		const guarded = (signal: AbortSignal) => this.withWorkerLease(fn, signal);
		const options = { ...this.execLockOptions, onLostAfterWork: async () => this.workerPool?.leaseLostAfterWork() };
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
		if (this.workerPool !== undefined && !this.workerPool.hasReservation(sessionKey(tenantId, sandboxId))) {
			return this.withWorkerAdmission(tenantId, sandboxId, true, () =>
				this.withExecLockShared(tenantId, sandboxId, fn),
			);
		}
		if (this.redis === undefined) return this.withWorkerLease(fn);
		const guarded = (signal: AbortSignal) => this.withWorkerLease(fn, signal);
		const options = { ...this.execLockOptions, onLostAfterWork: async () => this.workerPool?.leaseLostAfterWork() };
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
		return this.catalog.borrow(session, "exclusive", async () => {
			let primaryError: unknown;
			let failed = false;
			let result: T | undefined;
			try {
				await this.attachWorker(session);
				this.workerPool?.markRunning(lostSignal);
				await this.ensureFreshCache(tenantId, sandboxId, session);
				result = await fn(session);
				if (asCoherentFs(session.fs)?.poisoned()) {
					throw Object.assign(new Error("ECOHERENCE_UNAPPLIED: recovery failed; nothing was applied, retry is safe"), {
						code: "ECOHERENCE_UNAPPLIED",
					});
				}
			} catch (error) {
				primaryError = error;
				failed = true;
				try {
					await this.workerPool?.recover(error);
				} catch {}
			}
			try {
				const coherent = asCoherentFs(session.fs);
				if (coherent === undefined || coherent.wasDirty()) {
					this.catalog.refreshBudget(session);
					await coherent?.clearDirty();
				}
			} catch (error) {
				if (!failed) {
					try {
						await this.workerPool?.recover(error);
					} catch {}
					primaryError = error;
					failed = true;
				}
			}
			if (failed) throw primaryError;
			return result as T;
		});
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
		return this.catalog.borrow(session, "shared", async () => {
			const roFs = asReadOnlyFs(session.fs);
			const ctx: ReadOnlyContext = { violated: false };

			await this.attachWorker(session);
			this.workerPool?.markRunning(lostSignal);
			await this.ensureFreshCache(tenantId, sandboxId, session);
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
						await this.workerPool?.recover(err);
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
						throw Object.assign(new Error("EREADONLY_VIOLATION: readOnly script attempted to mutate the filesystem"), {
							code: "EREADONLY_VIOLATION",
						});
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
			}
		});
	}

	private async syncRuntime(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		const meta = await this.backends.getMeta(tenantId, sandboxId);
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
		const meta = await this.backends.updateRuntime(session.tenantId, session.sandboxId, runtime);
		if (meta === null) throw createEnoent(`/${session.sandboxId}`);
		return meta;
	}

	private async ensureFreshCache(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		const coherent = asCoherentFs(session.fs);
		if (coherent === undefined) return;
		try {
			const claimed = !(session.fs instanceof WorkerFileSystem) && (await coherent.claimGeneration?.()) === true;
			if ((await coherent.ensureFresh()) || claimed) await this.syncRuntime(tenantId, sandboxId, session);
			this.catalog.refreshBudget(session);
			this.catalog.assertActive(session);
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code !== "ENOENT" && code !== "ESANDBOXGONE") {
				this.catalog.assertActive(session);
				throw error;
			}
			this.catalog.closeMissing(session);
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
			const session = this.catalog.get(tenantId, sandboxId);
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
		_runtimeOptions?: RuntimeOptions,
	): Promise<T> {
		return this.withExecLockShared(tenantId, sandboxId, async (lostSignal) => {
			const session = this.catalog.get(tenantId, sandboxId);
			if (session !== undefined && session.state !== "closing") {
				return this.withSessionReadEntry(tenantId, sandboxId, session, fn, lostSignal);
			}
			return this.withSessionReadEntry(tenantId, sandboxId, await this.rehydrate(tenantId, sandboxId), fn, lostSignal);
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
		_runtimeOptions?: RuntimeOptions,
	): Promise<T> {
		return this.withExecLockExclusive(tenantId, sandboxId, async (lostSignal) => {
			const session = this.catalog.get(tenantId, sandboxId);
			if (session !== undefined && session.state !== "closing") {
				return this.withSessionEntry(tenantId, sandboxId, session, fn, lostSignal);
			}
			return this.withSessionEntry(tenantId, sandboxId, await this.rehydrate(tenantId, sandboxId), fn, lostSignal);
		});
	}

	private async rehydrate(tenantId: string, sandboxId: string): Promise<Session> {
		const meta = await this.backends.getMeta(tenantId, sandboxId);
		if (meta === null) throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
		const resolvedRuntime = { python: meta.python, javascript: meta.javascript, network: meta.network };
		const session = await this.getOrCreate(tenantId, sandboxId, resolvedRuntime, meta.owner ?? "", true);
		this.catalog.hydrateMetadata(session, meta);
		return session;
	}

	initializeSessionMetadata(session: Session, owner: string, name: string | null): void {
		this.catalog.initializeMetadata(session, owner, name);
	}

	async persistSandboxMeta(tenantId: string, sandboxId: string, meta: SandboxMeta): Promise<void> {
		await this.backends.persistMeta(tenantId, sandboxId, meta);
	}

	async getSandboxMeta(tenantId: string, sandboxId: string): Promise<SandboxMeta | null> {
		if (!isValidSandboxId(sandboxId)) return null;
		return this.backends.getMeta(tenantId, sandboxId);
	}

	async listSandboxes(tenantId: string, owner?: string): Promise<SandboxListEntry[]> {
		return this.backends.list(tenantId, owner);
	}

	async destroy(tenantId: string, sandboxId: string): Promise<boolean> {
		return this.withExecLockExclusive(tenantId, sandboxId, () =>
			this.catalog.destroy(tenantId, sandboxId, () => this.backends.destroy(tenantId, sandboxId)),
		);
	}

	startReaper(intervalMs = 60_000): void {
		this.catalog.startReaper(intervalMs);
	}

	stopReaper(): void {
		this.catalog.stopReaper();
	}

	async shutdown(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
		await this.catalog.shutdown(
			opts.drainTimeoutMs ?? 30_000,
			async (remainingMs) => {
				await this.workerPool?.shutdown(remainingMs);
			},
			() => this.runtimeAdmission.shutdown(),
		);
	}

	async closeAll(opts?: { drainTimeoutMs?: number }): Promise<void> {
		return this.shutdown(opts);
	}

	async execWithRuntimeThrottle(session: SessionRuntime, script: string, opts?: ExecOptions): Promise<BashExecResult> {
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

	private async execOnRuntime(session: SessionRuntime, script: string, opts?: ExecOptions): Promise<BashExecResult> {
		if (session.fs instanceof WorkerFileSystem && this.workerPool !== undefined) {
			const pool = this.workerPool;
			const fs = session.fs;
			return this.runtimeAdmission.run(session.runtimeOptions, opts?.signal, async () => {
				const { signal, ...options } = opts ?? {};
				const result = await pool.send(
					{ kind: "exec", script, options: { ...options, cwd: options.cwd ?? session.cwd } },
					signal,
				);
				const metadata = pool.metadata;
				if (metadata !== undefined) session.cwd = metadata.cwd;
				fs.refreshMetadata();
				return result;
			});
		}

		return this.runtimeAdmission.run(session.runtimeOptions, opts?.signal, () =>
			executeSessionRuntime(session, script, opts),
		);
	}
}
