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
}

export interface SessionManagerOptions {
	readonly backend: StorageBackend;
	readonly databaseUrl?: string;
	readonly createFs?: (backend: StorageBackend, sandboxId: string) => Promise<IFileSystem>;
}

export class SessionManager {
	private readonly sessions: Map<string, Session> = new Map();
	/** Single-flight map: tracks in-progress session creation */
	private readonly pending: Map<string, Promise<Session>> = new Map();
	private readonly backend: StorageBackend;
	private readonly createFs: (backend: StorageBackend, sandboxId: string) => Promise<IFileSystem>;

	constructor({ backend, createFs }: SessionManagerOptions) {
		this.backend = backend;
		this.createFs = createFs ?? createSandboxFs;
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
				const session: Session = {
					fs,
					bash,
					lastUsed: Date.now(),
					inFlight: 0,
					mutex: new Mutex(),
					state: "active",
					owner: "",
					createdAt: new Date().toISOString(),
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

		return session.mutex.runExclusive(async () => {
			session.inFlight++;
			try {
				return await fn(session);
			} finally {
				session.inFlight--;
			}
		});
	}

	/**
	 * Evicts the session from the in-memory pool and destroys backend data.
	 * Returns true if found and destroyed, false if the session was not in the pool.
	 * For DB backends, destroySandbox cleans up persistent data even if session not in pool.
	 */
	async destroy(sandboxId: string): Promise<boolean> {
		const session = this.sessions.get(sandboxId);
		if (session === undefined) {
			return false;
		}
		this.sessions.delete(sandboxId);
		await destroySandbox(this.backend, sandboxId);
		return true;
	}
}
