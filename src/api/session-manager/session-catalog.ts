import type { IFileSystem } from "just-bash";
import type { SandboxMeta } from "../../sql-fs/types.js";
import { RWLock } from "../rw-lock.js";
import type { SessionRuntime } from "../session-runtime/engine.js";

export interface Session extends SessionRuntime {
	bash: SessionRuntime["bash"];
	runtimeOptions: SessionRuntime["runtimeOptions"];
	readonly lastUsed: number;
	readonly inFlight: number;
	readonly lock: RWLock;
	readonly state: "active" | "closing";
	readonly owner: string;
	readonly name: string | null;
	readonly createdAt: string;
	readonly pathCacheBytes: number;
	readonly overBudget: boolean;
	readonly destroyPromise?: Promise<void>;
}

interface Resident {
	readonly session: Session;
	readonly lock: RWLock;
	lastUsed: number;
	inFlight: number;
	state: "active" | "closing";
	owner: string;
	name: string | null;
	createdAt: string;
	pathCacheBytes: number;
	overBudget: boolean;
	destroyPromise?: Promise<void>;
}

interface MutableRuntime extends SessionRuntime {
	bash: SessionRuntime["bash"];
	runtimeOptions: SessionRuntime["runtimeOptions"];
}

export interface SessionCatalogOptions {
	readonly idleMs?: number;
	readonly pathCacheMaxBytes?: number;
}

export interface SessionSource {
	readonly fs: IFileSystem;
	readonly owner: string;
	readonly createdAt: string;
	readonly createRuntime: () => SessionRuntime;
	readonly pathCacheBytes?: number;
}

export function sessionKey(tenantId: string, sandboxId: string): string {
	return `${tenantId}:${sandboxId}`;
}

async function disconnectFs(fs: IFileSystem): Promise<void> {
	if (!("disconnect" in fs) || typeof fs.disconnect !== "function") return;
	try {
		await fs.disconnect();
	} catch {}
}

function estimatePathCacheBytes(fs: IFileSystem): number {
	if ("getPathCacheBytes" in fs && typeof fs.getPathCacheBytes === "function") return fs.getPathCacheBytes();
	let total = 0;
	for (const path of fs.getAllPaths()) total += path.length + 100;
	return total;
}

export class SessionCatalog {
	private readonly sessions = new Map<string, Resident>();
	private readonly pending = new Map<string, Promise<Session>>();
	private readonly residents = new WeakMap<Session, Resident>();
	private readonly idleMs: number;
	private readonly pathCacheMaxBytes: number;
	private reaperTimer: ReturnType<typeof setInterval> | undefined;
	private shuttingDown = false;

	constructor({ idleMs, pathCacheMaxBytes }: SessionCatalogOptions) {
		this.idleMs = idleMs ?? Number(process.env.SESSION_IDLE_MS ?? "600000");
		this.pathCacheMaxBytes = pathCacheMaxBytes ?? 50 * 1024 * 1024;
	}

	get(tenantId: string, sandboxId: string): Session | undefined {
		return this.sessions.get(sessionKey(tenantId, sandboxId))?.session;
	}

	async getOrCreate(
		tenantId: string,
		sandboxId: string,
		create: () => Promise<SessionSource>,
		attach: (session: Session) => Promise<void>,
	): Promise<Session> {
		if (this.shuttingDown) {
			throw Object.assign(new Error("ESHUTTINGDOWN: server is shutting down"), { code: "ESHUTTINGDOWN" });
		}
		const key = sessionKey(tenantId, sandboxId);
		const existing = this.sessions.get(key);
		if (existing !== undefined) {
			try {
				await attach(existing.session);
			} catch (error) {
				if ((error as { code?: string } | null)?.code === "ENOENT") await existing.destroyPromise;
				throw error;
			}
			existing.lastUsed = Date.now();
			return existing.session;
		}
		const inProgress = this.pending.get(key);
		if (inProgress !== undefined) return inProgress;
		const creation = (async (): Promise<Session> => {
			let fs: IFileSystem | undefined;
			try {
				const source = await create();
				fs = source.fs;
				const runtime: MutableRuntime = source.createRuntime();
				const pathCacheBytes = source.pathCacheBytes ?? estimatePathCacheBytes(fs);
				if (this.shuttingDown) {
					throw Object.assign(new Error("ESHUTTINGDOWN: server is shutting down"), { code: "ESHUTTINGDOWN" });
				}
				const lifetime: Omit<Resident, "session"> = {
					lastUsed: Date.now(),
					inFlight: 0,
					lock: new RWLock(),
					state: "active",
					owner: source.owner,
					name: null,
					createdAt: source.createdAt,
					pathCacheBytes,
					overBudget: pathCacheBytes > this.pathCacheMaxBytes,
				};
				const session: Session = {
					...runtime,
					get bash() {
						return runtime.bash;
					},
					set bash(value) {
						runtime.bash = value;
					},
					get runtimeOptions() {
						return runtime.runtimeOptions;
					},
					set runtimeOptions(value) {
						runtime.runtimeOptions = value;
					},
					get cwd() {
						return runtime.cwd;
					},
					set cwd(value) {
						runtime.cwd = value;
					},
					get lock() {
						return lifetime.lock;
					},
					get lastUsed() {
						return lifetime.lastUsed;
					},
					get inFlight() {
						return lifetime.inFlight;
					},
					get state() {
						return lifetime.state;
					},
					get owner() {
						return lifetime.owner;
					},
					get name() {
						return lifetime.name;
					},
					get createdAt() {
						return lifetime.createdAt;
					},
					get pathCacheBytes() {
						return lifetime.pathCacheBytes;
					},
					get overBudget() {
						return lifetime.overBudget;
					},
					get destroyPromise() {
						return lifetime.destroyPromise;
					},
				};
				const resident: Resident = Object.assign(lifetime, { session });
				this.residents.set(session, resident);
				this.sessions.set(key, resident);
				fs = undefined;
				return session;
			} catch (error) {
				if (fs !== undefined) await disconnectFs(fs);
				throw error;
			} finally {
				this.pending.delete(key);
			}
		})();
		this.pending.set(key, creation);
		return creation;
	}

	private resident(session: Session): Resident {
		const resident = this.residents.get(session);
		if (resident === undefined) throw new Error("Session does not belong to this catalog");
		return resident;
	}

	assertActive(session: Session): void {
		if (session.state === "closing") {
			throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
		}
	}

	async borrow<T>(session: Session, mode: "shared" | "exclusive", fn: () => Promise<T>): Promise<T> {
		const resident = this.resident(session);
		this.assertActive(resident.session);
		const protectedWork = async (): Promise<T> => {
			this.assertActive(resident.session);
			resident.inFlight++;
			resident.lastUsed = Date.now();
			try {
				return await fn();
			} finally {
				resident.inFlight--;
			}
		};
		try {
			return await (mode === "shared"
				? resident.lock.runShared(protectedWork)
				: resident.lock.runExclusive(protectedWork));
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") await resident.destroyPromise;
			throw error;
		}
	}

	refreshBudget(session: Session): void {
		const resident = this.resident(session);
		resident.pathCacheBytes = estimatePathCacheBytes(session.fs);
		resident.overBudget = resident.pathCacheBytes > this.pathCacheMaxBytes;
	}

	initializeMetadata(session: Session, owner: string, name: string | null): void {
		const resident = this.resident(session);
		if (!resident.owner) resident.owner = owner;
		resident.name = name;
	}

	hydrateMetadata(session: Session, meta: SandboxMeta): void {
		const resident = this.resident(session);
		if (meta.owner) resident.owner = meta.owner;
		if (meta.name !== undefined) resident.name = meta.name;
		if (meta.createdAt !== undefined) resident.createdAt = meta.createdAt;
	}

	closeMissing(session: Session): void {
		const resident = this.resident(session);
		if (resident.destroyPromise !== undefined) return;
		resident.state = "closing";
		const key = sessionKey(session.tenantId, session.sandboxId);
		resident.destroyPromise = resident.lock.runExclusive(async () => {
			try {
				await disconnectFs(session.fs);
			} finally {
				if (this.sessions.get(key) === resident) this.sessions.delete(key);
			}
		});
	}

	async destroy(tenantId: string, sandboxId: string, destroyDurable: () => Promise<void>): Promise<boolean> {
		const key = sessionKey(tenantId, sandboxId);
		const resident = this.sessions.get(key);
		if (resident === undefined) {
			await destroyDurable();
			return false;
		}
		if (resident.destroyPromise !== undefined) {
			await resident.destroyPromise;
			return true;
		}
		resident.state = "closing";
		resident.destroyPromise = resident.lock.runExclusive(async () => {
			this.sessions.delete(key);
			try {
				await destroyDurable();
			} finally {
				await disconnectFs(resident.session.fs);
			}
		});
		await resident.destroyPromise;
		return true;
	}

	startReaper(intervalMs = 60_000): void {
		if (this.reaperTimer !== undefined) return;
		this.reaperTimer = setInterval(() => this.runReaper(), intervalMs);
		this.reaperTimer.unref?.();
	}

	stopReaper(): void {
		if (this.reaperTimer === undefined) return;
		clearInterval(this.reaperTimer);
		this.reaperTimer = undefined;
	}

	private runReaper(): void {
		const now = Date.now();
		for (const [key, resident] of this.sessions) {
			if (resident.state === "closing" || resident.inFlight !== 0) continue;
			if (resident.overBudget || now - resident.lastUsed > this.idleMs) {
				resident.state = "closing";
				this.sessions.delete(key);
				void resident.lock.runExclusive(() => disconnectFs(resident.session.fs));
			}
		}
	}

	async shutdown(
		drainTimeoutMs: number,
		drainWorkers: (remainingMs: number) => Promise<void>,
		rejectRuntimeWaiters: () => void,
	): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.stopReaper();
		const deadline = Date.now() + drainTimeoutMs;
		await drainWorkers(Math.max(0, deadline - Date.now()));
		for (const resident of this.sessions.values()) resident.state = "closing";
		rejectRuntimeWaiters();
		await Promise.allSettled(
			[...this.sessions.entries()].map(async ([key, resident]) => {
				const remaining = Math.max(0, deadline - Date.now());
				if (resident.destroyPromise !== undefined) {
					await Promise.race([resident.destroyPromise, new Promise<void>((resolve) => setTimeout(resolve, remaining))]);
					return;
				}
				try {
					await Promise.race([
						resident.lock.runExclusive(async () => {}),
						new Promise<void>((resolve) => setTimeout(resolve, remaining)),
					]);
				} catch {}
				this.sessions.delete(key);
				await disconnectFs(resident.session.fs);
			}),
		);
		this.sessions.clear();
	}
}
