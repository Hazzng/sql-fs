import type { LRUCache } from "lru-cache";
import { createEloop, createEnoent, createEnotdir, createEsandboxgone } from "../errors.js";
import { INODE_KIND, type PathCacheEntry, type SandboxGeneration, type SqlDialect } from "../types.js";
import { FileContents } from "./file-contents.js";
import { assertStoredPath, DEV_NULL, nameOf, parentOf, resolvePath, validatePath } from "./paths.js";
import type { ScriptPersistence } from "./script-persistence.js";
import type { ContentChange, PathChange, Publication, ScopeSettlement } from "./types.js";

interface CommittedView {
	epoch: bigint;
	readonly entries: Map<string, PathCacheEntry>;
}
interface FreshnessWaiter {
	readonly force: boolean;
	readonly resolve: (reloaded: boolean) => void;
	readonly reject: (error: unknown) => void;
}
export class CoherentView<Tx> {
	#committedView: CommittedView = { epoch: 0n, entries: new Map() };

	readonly #freshnessQueue: FreshnessWaiter[] = [];

	#freshnessRunning = false;

	#dirty = false;

	#cachePoisoned = false;

	#pathCacheBytes = 0;

	readonly #queries: Pick<SqlDialect<Tx>, "getSandboxEpoch" | "loadAllPaths" | "resolvePath">;

	readonly #sandboxId: string;

	readonly #persistence: Pick<
		ScriptPersistence<Tx>,
		"read" | "readSnapshot" | "assertAlive" | "scopeActive" | "buffering"
	>;

	readonly #contents: FileContents;

	constructor(
		queries: Pick<SqlDialect<Tx>, "getSandboxEpoch" | "loadAllPaths" | "resolvePath">,
		blobs: Pick<SqlDialect<Tx>, "getBlobNoTx" | "getBlobsForSandbox">,
		sandboxId: string,
		persistence: Pick<
			ScriptPersistence<Tx>,
			"read" | "readSnapshot" | "assertAlive" | "scopeActive" | "buffering" | "guarded"
		>,
		cap: number,
	) {
		this.#queries = queries;
		this.#sandboxId = sandboxId;
		this.#persistence = persistence;
		this.#contents = new FileContents(blobs, sandboxId, cap, (sha) =>
			persistence.guarded(() => blobs.getBlobNoTx(sha)),
		);
	}

	get #pathCache(): Map<string, PathCacheEntry> {
		return this.#committedView.entries;
	}

	childPaths(dirPath: string): string[] {
		const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
		const result: string[] = [];
		for (const key of this.#pathCache.keys()) {
			if (key === dirPath) continue;
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			if (!rest.includes("/")) result.push(key);
		}
		return result;
	}

	#updateCacheByInode(inodeId: bigint, patch: Partial<Omit<PathCacheEntry, "inodeId">>): void {
		for (const [p, e] of this.#pathCache) {
			if (e.inodeId === inodeId) this.#cacheSet(p, { ...e, ...patch });
		}
	}

	#cacheSet(key: string, entry: PathCacheEntry): void {
		const prior = this.#pathCache.get(key);
		this.#pathCacheBytes += prior === undefined ? key.length + 100 : -(prior.symlinkTarget?.length ?? 0) * 2;
		this.#pathCacheBytes += (entry.symlinkTarget?.length ?? 0) * 2;
		this.#pathCache.set(key, entry);
	}

	#cacheDelete(key: string): void {
		const prior = this.#pathCache.get(key);
		if (prior !== undefined && this.#pathCache.delete(key)) {
			this.#pathCacheBytes -= key.length + 100 + (prior.symlinkTarget?.length ?? 0) * 2;
		}
	}

	pathsUnder(dirPath: string): string[] {
		const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
		const result: string[] = [dirPath];
		for (const key of this.#pathCache.keys()) {
			if (key !== dirPath && key.startsWith(prefix)) result.push(key);
		}
		return result;
	}

	resolveCached(path: string): { path: string; entry: PathCacheEntry | null } {
		// Walks component by component, exactly as the dialect's `fs_resolve` does: a
		// symlink in an INTERMEDIATE component has to be resolved and the remaining
		// suffix continued from the target, because `/a/link/f` is never itself a
		// pathCache key — only the resolved `/a/dir/f` is. `hops` is shared across the
		// whole resolution so a cycle cannot escape by recursing.
		let hops = 0;
		const walk = (target: string): { path: string; entry: PathCacheEntry | null } => {
			if (target === DEV_NULL) return { path: target, entry: null };
			if (target.startsWith(`${DEV_NULL}/`)) throw createEnotdir(DEV_NULL);
			const root = this.#pathCache.get("/");
			if (!root) throw createEnoent(path);
			let current = "/";
			let entry: PathCacheEntry = root;
			const parts = target.split("/").filter((part) => part.length > 0);
			for (let i = 0; i < parts.length; i++) {
				if (entry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(current);
				const part = parts[i]!;
				const candidate = current === "/" ? `/${part}` : `${current}/${part}`;
				const next = this.#pathCache.get(candidate);
				if (!next) throw createEnoent(path);
				if (next.kind === INODE_KIND.SYMLINK) {
					if (++hops > 40) throw createEloop(path);
					const link = next.symlinkTarget;
					if (link === undefined || link === null) throw createEnoent(path);
					// Resolve the remaining suffix with the target. `/dev` need not have an
					// inode when a directory alias leads directly to the virtual `/dev/null`.
					const resolved = resolvePath(current, link);
					const suffix = parts.slice(i + 1).join("/");
					return walk(suffix.length > 0 ? resolvePath(resolved, suffix) : resolved);
				}
				current = candidate;
				entry = next;
			}
			return { path: current, entry };
		};
		return walk(path);
	}

	async resolveReadEntry(path: string): Promise<PathCacheEntry | null> {
		const entry = this.#pathCache.get(path);
		if (entry !== undefined && entry.kind !== INODE_KIND.SYMLINK) return entry;
		const buffered = this.#persistence.buffering;
		try {
			const cached = this.resolveCached(path);
			if (cached.entry === null || buffered) return cached.entry;
		} catch (err) {
			// Outside a buffered scope, an incomplete cache must not replace the dialect's
			// resolution of a stored symlink. Missing direct paths still fail locally.
			if (buffered || entry === undefined || (err as { code?: string }).code !== "ENOENT") throw err;
		}

		const resolvedId = await this.#persistence.read((tx) => this.#queries.resolvePath(tx, path, true));
		for (const [, e] of this.#pathCache) {
			if (e.inodeId === resolvedId) return e;
		}
		throw createEnoent(path);
	}

	requireParent(path: string): { parentPath: string; name: string; parentEntry: PathCacheEntry } {
		const parentPath = parentOf(path);
		const name = nameOf(path);
		const parentEntry = this.#pathCache.get(parentPath);
		if (!parentEntry) throw createEnoent(parentPath);
		if (parentEntry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(parentPath);
		return { parentPath, name, parentEntry };
	}

	async #loadCommittedView(force: boolean): Promise<boolean> {
		const view = await this.#persistence.readSnapshot(async (tx) => {
			const epoch = await this.#queries.getSandboxEpoch(tx, this.#sandboxId);
			if (!force && !this.#cachePoisoned && this.#pathCache.size > 0 && epoch === this.#committedView.epoch)
				return undefined;
			const rows = await this.#queries.loadAllPaths(tx);
			if (rows.length === 0) throw createEsandboxgone(this.#sandboxId);
			return { epoch, entries: new Map(rows.map(({ path, ...entry }) => [path, entry])) };
		});
		this.#persistence.assertAlive();
		if (view === undefined) return false;
		for (const path of view.entries.keys()) assertStoredPath(validatePath(path), "load reserved virtual device");
		this.#committedView = view;
		this.#pathCacheBytes = [...view.entries].reduce(
			(bytes, [path, entry]) => bytes + path.length + 100 + (entry.symlinkTarget?.length ?? 0) * 2,
			0,
		);

		this.#dirty = false;
		this.#cachePoisoned = false;
		this.#contents.installView(view.entries, (path, entry) => this.#contentEntryIsCurrent(path, entry));
		return true;
	}

	#queueFreshness(force: boolean): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this.#freshnessQueue.push({ force, resolve, reject });
			if (this.#freshnessRunning) return;
			this.#freshnessRunning = true;
			queueMicrotask(() => void this.#drainFreshness());
		});
	}

	async #drainFreshness(): Promise<void> {
		while (this.#freshnessQueue.length > 0) {
			const cohort = this.#freshnessQueue.splice(0);
			try {
				const reloaded = await this.#loadCommittedView(cohort.some((waiter) => waiter.force));
				for (const waiter of cohort) waiter.resolve(reloaded);
			} catch (error) {
				for (const waiter of cohort) waiter.reject(error);
			}
		}
		this.#freshnessRunning = false;
	}

	async ensureFresh(): Promise<boolean> {
		this.#persistence.assertAlive();
		if (this.#persistence.scopeActive)
			throw Object.assign(new Error("Freshness admission during a script scope"), { code: "EBUSY" });
		return this.#queueFreshness(false);
	}

	async ready(): Promise<void> {
		this.#persistence.assertAlive();
		await this.#queueFreshness(true);
	}

	async reload(): Promise<void> {
		this.#persistence.assertAlive();
		if (this.#persistence.scopeActive) return;
		await this.#queueFreshness(true);
	}

	wasDirty(): boolean {
		return this.#dirty;
	}

	clearDirty(): void {
		this.#dirty = false;
	}

	poisoned(): boolean {
		return this.#cachePoisoned;
	}

	#contentEntryIsCurrent(path: string, entry: PathCacheEntry): boolean {
		if (this.#pathCache.get(path) === entry) return true;
		if (this.#pathCache.get(path)?.kind !== INODE_KIND.SYMLINK) return false;
		return [...this.#pathCache.values()].some((current) => current === entry);
	}

	async realpath(inputPath: string): Promise<string> {
		this.#persistence.assertAlive();
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return path;
		const buffered = this.#persistence.buffering;
		try {
			const cached = this.resolveCached(path);
			if (cached.entry === null || buffered) return cached.path;
		} catch (err) {
			// The dialect remains the resolver for persisted paths outside a buffered scope.
			if (buffered || (err as { code?: string }).code !== "ENOENT") throw err;
		}
		const resolvedInodeId = await this.#persistence.read(async (tx) => this.#queries.resolvePath(tx, path, true));
		for (const [p, entry] of this.#pathCache) {
			if (entry.inodeId === resolvedInodeId) return p;
		}
		throw createEnoent(path);
	}

	get epoch(): bigint {
		return this.#committedView.epoch;
	}

	get pathCacheBytes(): number {
		return this.#pathCacheBytes;
	}

	get(path: string): PathCacheEntry | undefined {
		return this.#pathCache.get(path);
	}

	has(path: string): boolean {
		return this.#pathCache.has(path);
	}

	paths(): string[] {
		return [...this.#pathCache.keys()];
	}

	_getPathCache(): Map<string, PathCacheEntry> {
		return this.#pathCache;
	}

	_getContentCache(): LRUCache<bigint, Uint8Array> {
		return this.#contents._getCache();
	}

	poison(): void {
		this.#cachePoisoned = true;
	}

	markDirty(): void {
		this.#dirty = true;
	}

	async readBytes(path: string, entry: PathCacheEntry): Promise<Uint8Array> {
		const bytes = await this.#contents.read(path, entry);
		this.#persistence.assertAlive();
		return bytes;
	}

	publishGeneration(certificate: SandboxGeneration): boolean {
		if (!this.#cachePoisoned && certificate.priorEpoch === this.#committedView.epoch) {
			this.#committedView.epoch = certificate.epoch;
			return true;
		}
		return false;
	}

	publishMutation(
		publication: Publication,
		paths: readonly PathChange[],
		contents: readonly ContentChange[] = [],
		complete = true,
	): void {
		for (const change of paths) {
			switch (change.kind) {
				case "set":
					this.#cacheSet(change.path, change.entry);
					break;
				case "delete":
					this.#cacheDelete(change.path);
					break;
				case "patchInode":
					this.#updateCacheByInode(change.inodeId, change.patch);
					break;
			}
		}
		for (const change of contents) {
			if (change.kind === "evict") this.#contents.evict(change.inodeId);
			else this.#contents.put(change.inodeId, change.bytes);
		}
		if (publication.kind === "committed") this.#committedView.epoch = publication.epoch;
		if (complete) this.#dirty = true;
	}

	publishScope(receipt: Extract<ScopeSettlement, { kind: "committed" }>): void {
		const ids = receipt.inodeRemap;
		if (ids !== undefined) {
			for (const [path, entry] of this.#pathCache) {
				const real = ids.get(entry.inodeId);
				if (real !== undefined) this.#cacheSet(path, { ...entry, inodeId: real });
			}
			this.#contents.remap(ids);
			const unbound = [...this.#pathCache].filter(([, entry]) => entry.inodeId < 0n).map(([path]) => path);
			if (unbound.length > 0)
				throw Object.assign(
					new Error(
						`ECOHERENCE: script-tx flush left ${unbound.length} path(s) on provisional inode ids: ${unbound.slice(0, 5).join(", ")}`,
					),
					{ code: "ECOHERENCE" },
				);
		}
		this.#committedView.epoch = receipt.epoch;
	}
}
