/**
 * Session Manager — US-074
 * Maintains a pool of warm Bash sessions, one per sandboxId.
 */

import { Mutex } from "async-mutex";
import { Bash } from "just-bash";
import type { IFileSystem } from "just-bash";
import { createSandboxFs, destroySandbox } from "../fs/sql-fs/index.js";
import type { StorageBackend } from "../fs/sql-fs/index.js";

export interface Session {
	readonly fs: IFileSystem;
	readonly bash: Bash;
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

	constructor({ backend, createFs, destroySandboxFn, idleMs, pathCacheMaxBytes }: SessionManagerOptions) {
		this.backend = backend;
		this.createFs = createFs ?? createSandboxFs;
		this.destroySandboxFn = destroySandboxFn ?? destroySandbox;
		this.idleMs = idleMs ?? Number(process.env.SESSION_IDLE_MS ?? "600000");
		this.pathCacheMaxBytes = pathCacheMaxBytes ?? 50 * 1024 * 1024;
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
	 */
	async getOrCreate(sandboxId: string): Promise<Session> {
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

		const creationPromise = (async (): Promise<Session> => {
			try {
				const fs = await this.createFs(this.backend, sandboxId);
				const bash = new Bash({ fs });
				const pathCacheBytes = this.estimatePathCacheBytes(fs);
				const session: Session = {
					fs,
					bash,
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
	 */
	async withSession<T>(sandboxId: string, fn: (session: Session) => Promise<T>): Promise<T> {
		const session = await this.getOrCreate(sandboxId);

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
}
