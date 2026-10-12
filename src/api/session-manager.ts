import type { Redis } from "ioredis";
import { Bash } from "just-bash";
import type { BashExecResult, DefenseInDepthConfig, ExecOptions, IFileSystem, SecurityViolation } from "just-bash";
import { createEnoent } from "../sql-fs/errors.js";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../sql-fs/index.js";
import type { RedisBlobCache } from "../sql-fs/redis-blob-cache.js";
import { SessionScopedFs } from "../sql-fs/session-scoped-fs.js";
import type { ICoherentFs, IReadOnlyScopeFs, IScriptTxFs } from "../sql-fs/sql-fs.js";
import type { SandboxListEntry, SandboxMeta } from "../sql-fs/types.js";
import { type GitIdentity, createGitCommand, httpsOnlyGitFetch } from "./commands/git-command.js";
import { nodeCommand } from "./commands/node-command.js";
import { LockLostError, execLockKey, withDistributedLock } from "./distributed-lock.js";
import { type DistributedRWLockOptions, rwLockKeys, withDistributedRWLock } from "./distributed-rw-lock.js";
import { execFsError, extractErrCode } from "./errors.js";
import { type ExecContext, execContext } from "./exec-context.js";
import { logAudit } from "./lib/audit.js";
import { MAX_EXEC_FILE_BYTES } from "./lib/env.js";
import { posixNormalizePath } from "./lib/paths.js";
// NOTE: `py-exec` (warm host Python) is intentionally NOT imported/wired here.
// It spawned the HOST python3 with full `process.env`, which is a sandbox
// escape (RCE + secret/credential exfil — audit C1). The WASM `python3`
// command from just-bash (enabled via `python: true` below) is the safe path.
import { type ReadOnlyContext, readOnlyContext } from "./read-only-context.js";
import { RWLock } from "./rw-lock.js";
import type { TenantConfig } from "./tenants.js";

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
	/**
	 * When true, network-capable runtimes may use outbound HTTPS: `js-exec`
	 * gets unrestricted `fetch`, just-bash registers `curl`, and git remote
	 * transport can clone/fetch/push. Defaults to false (secure-by-default).
	 */
	readonly network: boolean;
}

const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = { python: false, javascript: false, network: false };

export function buildSandboxBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	const token = env.GITHUB_TOKEN;
	if (token) {
		out.GITHUB_TOKEN = token;
		out.GIT_HTTP_USER = "x-access-token";
		out.GIT_HTTP_PASSWORD = token;
	}
	return out;
}

/**
 * The deployment's default commit identity. It goes to just-git as its fallback identity rather
 * than into the sandbox env: GIT_AUTHOR_* env outranks `git -c user.*` and repo config, so as
 * env it silently overrode both. Author values win; committer values fill in.
 */
export function buildGitIdentity(env: NodeJS.ProcessEnv = process.env): GitIdentity | undefined {
	const name = env.GIT_AUTHOR_NAME || env.GIT_COMMITTER_NAME;
	const email = env.GIT_AUTHOR_EMAIL || env.GIT_COMMITTER_EMAIL;
	return name && email ? { name, email } : undefined;
}

const SANDBOX_NETWORK_CREDENTIAL_KEYS = new Set([
	"GITHUB_TOKEN",
	"GIT_HTTP_BEARER_TOKEN",
	"GIT_HTTP_USER",
	"GIT_HTTP_PASSWORD",
]);

/**
 * Re-derive git's HTTP credentials from a per-request `GITHUB_TOKEN`.
 *
 * just-bash merges the exec env over the base env key by key, so an override of `GITHUB_TOKEN`
 * alone leaves `GIT_HTTP_PASSWORD` holding the deployment token — `git clone`/`push` would keep
 * authenticating as the server while `curl $GITHUB_TOKEN` used the caller's. Each alias is
 * derived independently, so a request that pins only one half (`GIT_HTTP_USER: "oauth2"` for a
 * non-GitHub host, say) keeps it and still has the other half re-derived rather than inherited.
 * Only sandboxes that carry the credentials at all (network-enabled) are touched.
 */
export function deriveExecGitCredentials(
	env: Record<string, string> | undefined,
	network: boolean,
): Record<string, string> | undefined {
	if (env === undefined || !network) return env;
	if (!Object.hasOwn(env, "GITHUB_TOKEN")) return env;
	const out: Record<string, string> = Object.assign(Object.create(null), env);
	// An empty override means "no credentials": just-git only sends basic auth when both halves
	// are non-empty, so the pair below stays inert rather than falling back to the server token.
	// A request-supplied GIT_HTTP_BEARER_TOKEN still outranks the pair inside just-git.
	if (!Object.hasOwn(env, "GIT_HTTP_USER")) out.GIT_HTTP_USER = "x-access-token";
	if (!Object.hasOwn(env, "GIT_HTTP_PASSWORD")) out.GIT_HTTP_PASSWORD = env.GITHUB_TOKEN ?? "";
	return out;
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_AUDIT_NAMES = 20;
const MAX_ENV_AUDIT_NAME_LENGTH = 128;

function buildRuntimeSandboxEnv(baseEnv: Record<string, string>, network: boolean): Record<string, string> | undefined {
	const out: Record<string, string> = Object.create(null);
	for (const [key, value] of Object.entries(baseEnv)) {
		if (!network && SANDBOX_NETWORK_CREDENTIAL_KEYS.has(key)) continue;
		out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const SANDBOX_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSandboxId(id: string): boolean {
	return SANDBOX_ID_RE.test(id);
}

function assertValidSandboxId(sandboxId: string): void {
	if (!isValidSandboxId(sandboxId)) {
		throw Object.assign(new Error("EINVAL: invalid sandbox id"), { code: "EINVAL" });
	}
}

/** Matches `python3` or `python` as a standalone word (avoids false positives like `mypython`). */
const PYTHON_INVOCATION_REGEX = /\bpython3?\b/;
/** Matches `js-exec` or `node` as a standalone command word (avoids `mynode`, `nodejs-config`, etc). */
const JS_INVOCATION_REGEX = /\bjs-exec\b|\bnode\b/;

export interface Session {
	readonly fs: IFileSystem;
	bash: Bash;
	runtimeOptions: RuntimeOptions;
	readonly tenantId: string;
	readonly sandboxId: string;
	readonly scriptTx: SessionScopedFs | undefined;
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
	/**
	 * AbortSignal that fires when the distributed exec lock is DEFINITIVELY lost
	 * (lease expired or ownership taken by another holder) for the currently
	 * locked region. Set by `withExecLockExclusive` / `withExecLockShared` before
	 * the inner `fn` runs and cleared in their `finally`. Undefined when no
	 * distributed lock is held (single-replica / Redis disabled). The exec routes
	 * compose this with their timeout signal so `bash.exec` aborts — and the
	 * script-tx rolls back — BEFORE any commit on a lost lease (F2-L1).
	 */
	lockLostSignal?: AbortSignal;
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
	/** Weak references keep warning deduplication bounded by the warm session lifetime. */
	private readonly unsupportedEnvWarned = new WeakSet<Session>();
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
				tenantId,
				blobCache: backend.blobCache,
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

	private buildBash(sandboxId: string, fs: IFileSystem, resolvedRuntime: RuntimeOptions): Bash {
		const defenseInDepthConfig: DefenseInDepthConfig | false = this.defenseInDepth
			? {
					enabled: true,
					auditMode: this.defenseAuditMode,
					onViolation: (v: SecurityViolation) => logAudit("defense_in_depth_violation", { sandboxId, ...v }),
				}
			: false;

		// NOTE: the `py-exec` warm-host-Python custom command is deliberately
		// not registered (audit C1 — host sandbox escape). Python sandboxes
		// run via just-bash's WASM `python3` (`python: true`), which is isolated.
		// `{}` → no allowlist → full outbound via globalThis.fetch.
		// `false` → clone/fetch/push blocked; local git still works.
		// The wrapper removes the destination of a clone that fails partway,
		// so a refused symlink cannot leave a poisoned index behind.
		const gitCommand = createGitCommand({
			network: resolvedRuntime.network ? { fetch: httpsOnlyGitFetch } : false,
			identity: this.gitIdentity,
		});
		const customCommands = [
			// Override just-bash's built-in nodeStubCommand with a smarter
			// version that translates `node -e CODE` → `js-exec -c CODE` and
			// `node FILE` → `js-exec FILE` instead of dumping a help wall.
			// Only registered when the javascript runtime is enabled so that
			// non-JS sandboxes keep the default "command not found" behaviour.
			...(resolvedRuntime.javascript ? [nodeCommand] : []),
			gitCommand,
		];

		return new Bash({
			fs,
			python: resolvedRuntime.python || undefined,
			javascript: resolvedRuntime.javascript || undefined,
			// When network is enabled, grant js-exec unrestricted outbound HTTPS.
			// just-bash also registers curl through secureFetch; git remote
			// transport is gated separately above and uses globalThis.fetch.
			network: resolvedRuntime.network ? { dangerouslyAllowFullInternetAccess: true } : undefined,
			env: buildRuntimeSandboxEnv(this.sandboxBaseEnv, resolvedRuntime.network),
			defenseInDepth: defenseInDepthConfig,
			customCommands: customCommands.length > 0 ? customCommands : undefined,
		});
	}

	async getOrCreate(
		tenantId: string,
		sandboxId: string,
		runtimeOptions?: RuntimeOptions,
		owner = "",
	): Promise<Session> {
		assertValidSandboxId(sandboxId);
		if (this.shuttingDown) {
			throw Object.assign(new Error("ESHUTTINGDOWN: server is shutting down"), { code: "ESHUTTINGDOWN" });
		}
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
			let createdFs: IFileSystem | undefined;
			try {
				const { fs, resolvedOwner, createdAt: fsCreatedAt } = await this.buildFs(tenantId, sandboxId, owner);
				createdFs = fs;
				const bash = this.buildBash(sandboxId, fs, resolvedRuntime);
				const pathCacheBytes = this.estimatePathCacheBytes(fs);
				const scriptTxFs = asScriptTxFs(fs);
				const scriptTx = scriptTxFs !== undefined ? new SessionScopedFs(scriptTxFs) : undefined;

				// Shutdown may have begun while buildFs() was running. If so, refuse
				// to register the session — shutdown's snapshot has already been
				// taken and would never see this fs, leaking its dialect pool.
				if (this.shuttingDown) {
					throw Object.assign(new Error("ESHUTTINGDOWN: server is shutting down"), { code: "ESHUTTINGDOWN" });
				}
				const session: Session = {
					fs,
					bash,
					runtimeOptions: resolvedRuntime,
					tenantId,
					sandboxId,
					scriptTx,
					lastUsed: Date.now(),
					inFlight: 0,
					lock: new RWLock(),
					state: "active",
					owner: resolvedOwner,
					name: null,
					createdAt: fsCreatedAt,
					pathCacheBytes,
					overBudget: pathCacheBytes > this.pathCacheMaxBytes,
					cwd: bash.getCwd(),
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

	getSession(tenantId: string, sandboxId: string): Session | undefined {
		return this.sessions.get(this.sessionKey(tenantId, sandboxId));
	}

	private async withExecLockExclusive<T>(
		tenantId: string,
		sandboxId: string,
		fn: (lostSignal?: AbortSignal) => Promise<T>,
	): Promise<T> {
		assertValidSandboxId(sandboxId);
		if (this.redis === undefined) return fn();
		if (!this.rwlockEnabled) {
			return withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), fn, this.execLockOptions);
		}
		return withDistributedRWLock(this.redis, rwLockKeys(tenantId, sandboxId), "exclusive", fn, this.execLockOptions);
	}

	private async withExecLockShared<T>(
		tenantId: string,
		sandboxId: string,
		fn: (lostSignal?: AbortSignal) => Promise<T>,
	): Promise<T> {
		assertValidSandboxId(sandboxId);
		if (this.redis === undefined) return fn();
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
			return withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), fn, {
				...this.execLockOptions,
				readOnly: true,
			});
		}
		return withDistributedRWLock(this.redis, rwLockKeys(tenantId, sandboxId), "shared", fn, this.execLockOptions);
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

		// F2-L1: expose the distributed lock's definitive-loss signal to the exec
		// routes (which compose it into bash.exec's abort signal) for the duration
		// of this locked region. Cleared in finally so a stale signal never leaks
		// into a later turn that re-uses the warm session.
		session.lockLostSignal = lostSignal;
		try {
			return await session.lock.runExclusive(async () => {
				if (session.state === "closing") {
					throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), {
						code: "ESESSIONCLOSING",
					});
				}
				session.inFlight++;
				session.lastUsed = Date.now();
				try {
					await this.ensureFreshCache(tenantId, sandboxId, session);
				} catch (error) {
					session.inFlight--;
					throw error;
				}
				try {
					const result = await fn(session);
					if (asCoherentFs(session.fs)?.poisoned()) {
						throw Object.assign(
							new Error("ECOHERENCE_UNAPPLIED: recovery failed; nothing was applied, retry is safe"),
							{ code: "ECOHERENCE_UNAPPLIED" },
						);
					}
					return result;
				} finally {
					try {
						const coherent = asCoherentFs(session.fs);
						if (coherent === undefined || coherent.wasDirty()) {
							session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
							session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
							await coherent?.clearDirty();
						}
					} finally {
						session.inFlight--;
					}
				}
			});
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") await session.destroyPromise;
			throw error;
		} finally {
			session.lockLostSignal = undefined;
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

		// F2-L1: expose the distributed shared lock's definitive-loss signal to the
		// exec routes for this locked region (see withSessionEntry). Cleared in
		// finally so it never leaks into a later turn reusing this warm session.
		// NOTE: multiple readers share one warm session; they all observe the same
		// lockLostSignal, which is correct — a shared-lock loss invalidates them all.
		session.lockLostSignal = lostSignal;
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
		} finally {
			session.lockLostSignal = undefined;
		}
	}

	private async syncRuntime(tenantId: string, sandboxId: string, session: Session): Promise<void> {
		const meta = await this.getSandboxMetaFn?.(tenantId, sandboxId);
		if (!meta) return;
		const { python, javascript, network } = meta;
		const current = session.runtimeOptions;
		if (python === current.python && javascript === current.javascript && network === current.network) return;
		session.runtimeOptions = { python, javascript, network };
		session.bash = this.buildBash(sandboxId, session.fs, session.runtimeOptions);
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
			if (await coherent.ensureFresh()) await this.syncRuntime(tenantId, sandboxId, session);
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
			if (session.state !== "closing") {
				session.state = "closing";
				session.destroyPromise = session.lock.runExclusive(async () => {
					await this.disconnectFs(session.fs);
					this.sessions.delete(this.sessionKey(tenantId, sandboxId));
				});
			}
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
		const session = await this.getOrCreate(tenantId, sandboxId, resolvedRuntime, meta?.owner ?? "");
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
		const session = await this.getOrCreate(tenantId, sandboxId, resolvedRuntime, meta?.owner ?? "");
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

		const deadline = Date.now() + drainTimeoutMs;
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
		const usesPython = session.runtimeOptions.python && PYTHON_INVOCATION_REGEX.test(script);
		const usesJs = session.runtimeOptions.javascript && JS_INVOCATION_REGEX.test(script);

		// Apply the session-tracked cwd as the starting directory for this exec,
		// unless the caller has already supplied an explicit cwd in the request.
		// just-bash runs each exec against a copy of the interpreter state, so
		// any `cd` executed inside a script does not survive the call. We bridge
		// that gap by reading result.env.PWD (always populated by just-bash) and
		// storing it back on the session after every non-readOnly exec.
		const resolvedOpts: ExecOptions = {
			...opts,
			cwd: opts?.cwd ?? session.cwd,
			env: deriveExecGitCredentials(opts?.env, session.runtimeOptions.network),
		};
		// Bash cannot export these names. Warn once per warm session with a bounded
		// sample, without ever logging values or retaining caller-controlled names.
		if (!this.unsupportedEnvWarned.has(session) && resolvedOpts.env !== undefined) {
			const variableNames: string[] = [];
			let omittedNameCount = 0;
			let truncatedNameCount = 0;
			for (const name in resolvedOpts.env) {
				if (!Object.hasOwn(resolvedOpts.env, name) || SHELL_NAME.test(name)) continue;
				if (variableNames.length >= MAX_ENV_AUDIT_NAMES) {
					omittedNameCount++;
					continue;
				}
				variableNames.push(name.slice(0, MAX_ENV_AUDIT_NAME_LENGTH));
				if (name.length > MAX_ENV_AUDIT_NAME_LENGTH) truncatedNameCount++;
			}
			if (variableNames.length > 0) {
				this.unsupportedEnvWarned.add(session);
				logAudit("exec_env_not_exported", {
					tenantId: session.tenantId,
					sandboxId: session.sandboxId,
					variableNames,
					omittedNameCount,
					truncatedNameCount,
					severity: "warn",
				});
			}
		}

		// readOnly execs skip scriptTx entirely: the FS rejects all writes via
		// EREADONLY before any DB call, so the per-script transaction has
		// nothing to commit, and beginScope/endScope on the shared SessionScopedFs
		// would race across concurrent parallel readers.
		const inReadOnlyScope = readOnlyContext.getStore() !== undefined;
		const runExec = async (ctx: ExecContext): Promise<BashExecResult> => {
			if (!inReadOnlyScope && session.scriptTx !== undefined) {
				session.scriptTx.beginScope();
				try {
					const result = await session.bash.exec(script, resolvedOpts);
					// F2-L1: just-bash treats an aborted run as a RESOLVED result (exit
					// 124), not a rejection — so a definitive lock loss would otherwise
					// fall through to endScope() and COMMIT a partially-run script under a
					// lease we no longer hold. If the lock's lost-signal fired, ROLL BACK
					// instead and surface ELOCKLOST so the client retries a write that
					// never committed (rather than getting a committed-then-failed lie).
					// NOTE: a plain timeout abort still commits (audit L7) — we key off the
					// dedicated lockLostSignal, not the composed exec signal.
					if (session.lockLostSignal?.aborted === true) {
						await session.scriptTx.abortScope();
						throw new LockLostError("exec aborted: distributed exec lock lost mid-script");
					}
					// #168: bash normalized the EFBIG into a phantom "No such file or directory"
					// and a plain exit 1, so the script "succeeded" and is about to commit.
					// Roll it back and surface the real error — partially applying a script whose
					// failure the client was told was a missing file is the worse outcome.
					if (ctx.exceeded !== undefined) {
						await session.scriptTx.abortScope();
						throw ctx.exceeded;
					}
					await session.scriptTx.endScope();
					return result;
				} catch (err) {
					await session.scriptTx.abortScope();
					throw err;
				}
			}
			const readOnlyResult = await session.bash.exec(script, resolvedOpts);
			if (ctx.exceeded !== undefined) throw ctx.exceeded;
			return readOnlyResult;
		};

		// #168: the one chokepoint every exec surface (sync, SSE, batch, MCP) funnels
		// through, so the script's file-size ceiling is established here and nowhere
		// else. Scoped to the call rather than set on the shared session FS — see
		// `exec-context.ts` for why a flag would be wrong.
		const execFn = async (): Promise<BashExecResult> => {
			const ctx: ExecContext = { maxFileBytes: MAX_EXEC_FILE_BYTES };
			try {
				return await execContext.run(ctx, () => runExec(ctx));
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
		};

		const updateCwd = (result: BashExecResult): BashExecResult => {
			// readOnly execs must not mutate session state — they run in shared
			// lock mode and may execute concurrently with other readers.
			if (!inReadOnlyScope) {
				const finalCwd = result.env?.PWD;
				// Validate before storing: reject null bytes (security) and un-normalized segments, so a
				// script that does `export PWD=…` cannot corrupt session.cwd. A RELATIVE value is dropped
				// rather than rooted — `foo` is not evidence that `/foo` exists, and keeping the last
				// known-good cwd beats inventing one the next exec would start from.
				if (typeof finalCwd === "string" && finalCwd.startsWith("/") && !finalCwd.includes("\0")) {
					session.cwd = posixNormalizePath(finalCwd);
				}
			}
			return result;
		};

		if (!usesPython && !usesJs) {
			return updateCwd(await execFn());
		}

		const signal = opts?.signal;
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
			return updateCwd(await execFn());
		} finally {
			if (usesJs) this.releaseSlot(this.jsSem);
			if (usesPython) this.releaseSlot(this.pythonSem);
		}
	}
}
