/**
 * Session Manager — US-074
 * Maintains a pool of warm Bash sessions, one per sandboxId.
 */

import { Mutex } from "async-mutex";
import { Bash } from "just-bash";
import type { ExecOptions, IFileSystem } from "just-bash";
import type { BashExecResult } from "just-bash";
import { createSandboxFs, destroySandbox } from "../fs/sql-fs/index.js";
import type { StorageBackend } from "../fs/sql-fs/index.js";

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
}

export interface SessionManagerOptions {
	readonly backend: StorageBackend;
	readonly databaseUrl?: string;
	readonly createFs?: (backend: StorageBackend, sandboxId: string) => Promise<IFileSystem>;
	/** Override for destroySandbox — used for dependency injection in tests */
	readonly destroySandboxFn?: (backend: StorageBackend, sandboxId: string) => Promise<void>;
	/** Idle timeout in ms before a session is eligible for eviction (default: SESSION_IDLE_MS env var or 600000) */
	readonly idleMs?: number;
	/** Max pathCache bytes per session before it is marked over-budget (default: 50MB) */
	readonly pathCacheMaxBytes?: number;
	/** Max concurrent Python executions across all sessions (default: MAX_CONCURRENT_PYTHON env var or 5) */
	readonly maxConcurrentPython?: number;
	/** Max concurrent JavaScript (js-exec/node) executions across all sessions (default: MAX_CONCURRENT_JS env var or 5) */
	readonly maxConcurrentJs?: number;
}

/** Internal FIFO-semaphore state shared by the python and js throttles. */
interface Semaphore {
	readonly limit: number;
	inFlight: number;
	readonly waiters: Array<() => void>;
}

export class SessionManager {
	private readonly sessions: Map<string, Session> = new Map();
	/** Single-flight map: tracks in-progress session creation */
	private readonly pending: Map<string, Promise<Session>> = new Map();
	private readonly backend: StorageBackend;
	private readonly createFs: (backend: StorageBackend, sandboxId: string) => Promise<IFileSystem>;
	private readonly destroySandboxFn: (backend: StorageBackend, sandboxId: string) => Promise<void>;
	private readonly idleMs: number;
	private readonly pathCacheMaxBytes: number;
	private reaperTimer: ReturnType<typeof setInterval> | undefined;

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
		backend,
		createFs,
		destroySandboxFn,
		idleMs,
		pathCacheMaxBytes,
		maxConcurrentPython,
		maxConcurrentJs,
	}: SessionManagerOptions) {
		this.backend = backend;
		this.createFs = createFs ?? createSandboxFs;
		this.destroySandboxFn = destroySandboxFn ?? destroySandbox;
		this.idleMs = idleMs ?? Number(process.env.SESSION_IDLE_MS ?? "600000");
		this.pathCacheMaxBytes = pathCacheMaxBytes ?? 50 * 1024 * 1024;
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
	 * Concurrent calls for the same sandboxId are coalesced into a single creation (single-flight).
	 *
	 * `runtimeOptions` are applied only on **cache miss** — the first caller "wins" the runtime flags.
	 * Subsequent callers receive the warm session regardless of the flags they pass.
	 */
	async getOrCreate(sandboxId: string, runtimeOptions?: RuntimeOptions): Promise<Session> {
		const existing = this.sessions.get(sandboxId);
		if (existing !== undefined) {
			existing.lastUsed = Date.now();
			return existing;
		}

		// If another getOrCreate is already creating this session, reuse its promise
		const inProgress = this.pending.get(sandboxId);
		if (inProgress !== undefined) {
			return inProgress;
		}

		const resolvedRuntime: RuntimeOptions = runtimeOptions ?? DEFAULT_RUNTIME_OPTIONS;

		const creationPromise = (async (): Promise<Session> => {
			try {
				const fs = await this.createFs(this.backend, sandboxId);
				// just-bash treats `false` and `undefined` both as off, but the types distinguish them —
				// `|| undefined` keeps types happy without changing behavior.
				const bash = new Bash({
					fs,
					python: resolvedRuntime.python || undefined,
					javascript: resolvedRuntime.javascript || undefined,
				});
				const pathCacheBytes = this.estimatePathCacheBytes(fs);
				const session: Session = {
					fs,
					bash,
					runtimeOptions: resolvedRuntime,
					lastUsed: Date.now(),
					inFlight: 0,
					mutex: new Mutex(),
					state: "active",
					owner: "",
					createdAt: new Date().toISOString(),
					pathCacheBytes,
					overBudget: pathCacheBytes > this.pathCacheMaxBytes,
				};
				this.sessions.set(sandboxId, session);
				return session;
			} finally {
				this.pending.delete(sandboxId);
			}
		})();

		this.pending.set(sandboxId, creationPromise);
		return creationPromise;
	}

	/**
	 * Returns the session for the given sandboxId, or undefined if not found.
	 */
	getSession(sandboxId: string): Session | undefined {
		return this.sessions.get(sandboxId);
	}

	/**
	 * Acquires the per-sandbox mutex, tracks inFlight, then calls fn(session).
	 * Same-sandbox operations are serialized — later requests wait for earlier ones.
	 *
	 * `runtimeOptions` are forwarded to `getOrCreate` — applied only on cache miss.
	 * A warm session ignores subsequent runtimeOptions; the first caller's flags stick.
	 */
	async withSession<T>(
		sandboxId: string,
		fn: (session: Session) => Promise<T>,
		runtimeOptions?: RuntimeOptions,
	): Promise<T> {
		const session = await this.getOrCreate(sandboxId, runtimeOptions);

		// Fast-fail: session is being destroyed — don't queue in the mutex
		if (session.state === "closing") {
			throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
		}

		return session.mutex.runExclusive(async () => {
			// Re-check inside mutex in case destroy was called between the check above and acquiring the lock
			if (session.state === "closing") {
				throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
			}
			session.inFlight++;
			try {
				return await fn(session);
			} finally {
				session.inFlight--;
				session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
				session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
			}
		});
	}

	/**
	 * Like withSession, but throws ENOENT if the sandbox is not already in the pool.
	 * Use this for operation routes that should NOT auto-create sandboxes.
	 */
	async withExistingSession<T>(sandboxId: string, fn: (session: Session) => Promise<T>): Promise<T> {
		const session = this.sessions.get(sandboxId);
		if (session === undefined) {
			throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
		}

		if (session.state === "closing") {
			throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
		}

		return session.mutex.runExclusive(async () => {
			if (session.state === "closing") {
				throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
			}
			session.inFlight++;
			session.lastUsed = Date.now();
			try {
				return await fn(session);
			} finally {
				session.inFlight--;
				session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
				session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
			}
		});
	}

	/**
	 * Marks the session as closing, waits for any in-flight work to finish, then removes it
	 * from the pool and destroys backend data. Concurrent calls are idempotent — destroySandbox
	 * is called exactly once. Returns true if the session was in the pool, false otherwise.
	 * Even when the session is not in the pool, destroySandbox is still called for DB cleanup.
	 */
	async destroy(sandboxId: string): Promise<boolean> {
		const session = this.sessions.get(sandboxId);

		if (session === undefined) {
			// Session not in pool — still clean up backend data
			await this.destroySandboxFn(this.backend, sandboxId);
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
			this.sessions.delete(sandboxId);
			await this.destroySandboxFn(this.backend, sandboxId);
		});
		session.destroyPromise = p;

		await p;
		return true;
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
		for (const [sandboxId, session] of this.sessions) {
			if (session.state === "closing") continue;
			if (session.inFlight !== 0) continue;
			// Over-budget sessions are evicted immediately when idle (no idle timeout)
			if (session.overBudget || now - session.lastUsed > this.idleMs) {
				this.sessions.delete(sandboxId);
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
