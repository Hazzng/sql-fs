/**
 * SqlFs: IFileSystem implementation backed by a SQL dialect.
 * Caches the full path tree in memory (pathCache) and file content (contentCache).
 *
 * US-019: pathCache initialization from loadAllPaths
 * US-020: pathCache update on write operations
 * US-022: LRU content cache setup
 */

import { createHash } from "node:crypto";
import type { CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";
import { LRUCache } from "lru-cache";

import {
	createEexist,
	createEinval,
	createEisdir,
	createEnoent,
	createEnotdir,
	createEnotempty,
	createEperm,
} from "./errors.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// Extract optional-parameter types from IFileSystem to avoid importing
// from just-bash internal paths (ReadFileOptions, WriteFileOptions, DirentEntry are not
// publicly re-exported from the just-bash main entry point).
type ReadFileOpts = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOpts = Parameters<IFileSystem["writeFile"]>[2];
type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>>[number];

const DEFAULT_CONTENT_CACHE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

interface SqlFsOptions<Tx> {
	readonly dialect: SqlDialect<Tx>;
	readonly sandboxId: string;
	/** Max total byte budget for the content cache. Default: 50 MB. */
	readonly contentCacheMaxBytes?: number;
}

export class SqlFs<Tx = unknown> implements IFileSystem {
	readonly #dialect: SqlDialect<Tx>;
	readonly #sandboxId: string;
	readonly #pathCache: Map<string, PathCacheEntry>;
	readonly #contentCache: LRUCache<bigint, Uint8Array>;

	constructor(opts: SqlFsOptions<Tx>) {
		this.#dialect = opts.dialect;
		this.#sandboxId = opts.sandboxId;
		this.#pathCache = new Map();
		this.#contentCache = new LRUCache<bigint, Uint8Array>({
			maxSize: opts.contentCacheMaxBytes ?? DEFAULT_CONTENT_CACHE_MAX_BYTES,
			sizeCalculation: (value) => value.byteLength,
		});
	}

	// ── Content cache helpers (for use by readFile/writeFile in later stories) ──

	/** @internal Used by unit tests and future readFile/writeFile implementations. */
	_contentCacheGet(inodeId: bigint): Uint8Array | undefined {
		return this.#contentCache.get(inodeId);
	}

	/** @internal Used by unit tests and future readFile/writeFile implementations. */
	_contentCacheSet(inodeId: bigint, data: Uint8Array): void {
		this.#contentCache.set(inodeId, data);
	}

	/** @internal Used by unit tests. */
	_contentCacheHas(inodeId: bigint): boolean {
		return this.#contentCache.has(inodeId);
	}

	// ── Transaction helper ────────────────────────────────────────────────────────

	async #withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		return this.#dialect.transaction(async (tx) => {
			await this.#dialect.setSandboxContext(tx, this.#sandboxId);
			return await fn(tx);
		});
	}

	// ── Path helpers ──────────────────────────────────────────────────────────────

	/** Returns the parent path of an absolute path. '/' has no parent. */
	#parentOf(path: string): string {
		const idx = path.lastIndexOf("/");
		if (idx === 0) return "/";
		return path.slice(0, idx);
	}

	/** Returns the base name component of an absolute path. */
	#nameOf(path: string): string {
		return path.slice(path.lastIndexOf("/") + 1);
	}

	/** Returns all pathCache paths that are direct children of the given dir path. */
	#childPaths(dirPath: string): string[] {
		const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
		const result: string[] = [];
		for (const key of this.#pathCache.keys()) {
			if (key === dirPath) continue;
			if (!key.startsWith(prefix)) continue;
			// Direct child: no additional slash after prefix
			const rest = key.slice(prefix.length);
			if (!rest.includes("/")) result.push(key);
		}
		return result;
	}

	/** Returns all pathCache paths rooted at dirPath (inclusive). */
	#allPathsUnder(dirPath: string): string[] {
		const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
		const result: string[] = [dirPath];
		for (const key of this.#pathCache.keys()) {
			if (key !== dirPath && key.startsWith(prefix)) result.push(key);
		}
		return result;
	}

	/**
	 * Initialises the in-memory pathCache by loading all paths from the DB
	 * via a single recursive CTE query.  Must be called once before any FS op.
	 */
	async ready(): Promise<void> {
		const entries = await this.#dialect.transaction(async (tx) => {
			await this.#dialect.setSandboxContext(tx, this.#sandboxId);
			return await this.#dialect.loadAllPaths(tx);
		});
		this.#pathCache.clear();
		for (const { path, ...entry } of entries) {
			this.#pathCache.set(path, entry);
		}
	}

	// ── IFileSystem: cache-served methods ────────────────────────────────────────

	getAllPaths(): string[] {
		return [...this.#pathCache.keys()];
	}

	// ── IFileSystem: write operations with pathCache updates ─────────────────────

	async writeFile(path: string, content: FileContent, _options?: WriteFileOpts): Promise<void> {
		const parentPath = this.#parentOf(path);
		const name = this.#nameOf(path);

		const parentEntry = this.#pathCache.get(parentPath);
		if (!parentEntry) throw createEnoent(parentPath);
		if (parentEntry.kind !== 2) throw createEnotdir(parentPath);

		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const sha256 = new Uint8Array(createHash("sha256").update(bytes).digest());
		const mtime = new Date();

		const inodeId = await this.#withTx(async (tx) => {
			await this.#dialect.upsertBlob(tx, sha256, bytes);
			const id = await this.#dialect.createInode(tx, {
				sandboxId: this.#sandboxId,
				kind: 1,
				mode: 0o644,
				size: bytes.length,
				contentSha256: sha256,
			});
			const oldInodeId = await this.#dialect.upsertDirent(tx, parentEntry.inodeId, name, id);
			if (oldInodeId !== null) {
				const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
				if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
			}
			return id;
		});

		this.#pathCache.set(path, {
			inodeId,
			kind: 1,
			mode: 0o644,
			size: bytes.length,
			mtime,
			contentSha256: sha256,
			symlinkTarget: null,
		});
		this.#contentCache.set(inodeId, bytes);
	}

	async appendFile(path: string, content: FileContent, _options?: WriteFileOpts): Promise<void> {
		const parentPath = this.#parentOf(path);
		const name = this.#nameOf(path);

		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const mtime = new Date();

		const existing = this.#pathCache.get(path);
		let fullBytes: Uint8Array;

		if (existing && existing.kind === 1 && existing.contentSha256 !== null) {
			const oldContent = await this.#withTx(async (tx) => this.#dialect.getBlob(tx, existing.contentSha256!));
			const base = oldContent ?? new Uint8Array(0);
			const merged = new Uint8Array(base.length + bytes.length);
			merged.set(base, 0);
			merged.set(bytes, base.length);
			fullBytes = merged;
		} else {
			fullBytes = bytes;
		}

		const sha256 = new Uint8Array(createHash("sha256").update(fullBytes).digest());
		const parentEntry = this.#pathCache.get(parentPath);
		if (!parentEntry) throw createEnoent(parentPath);
		if (parentEntry.kind !== 2) throw createEnotdir(parentPath);

		let replacedInodeId: bigint | null = null;
		const inodeId = await this.#withTx(async (tx) => {
			await this.#dialect.upsertBlob(tx, sha256, fullBytes);
			const id = await this.#dialect.createInode(tx, {
				sandboxId: this.#sandboxId,
				kind: 1,
				mode: 0o644,
				size: fullBytes.length,
				contentSha256: sha256,
			});
			const oldInodeId = await this.#dialect.upsertDirent(tx, parentEntry.inodeId, name, id);
			if (oldInodeId !== null) {
				replacedInodeId = oldInodeId;
				const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
				if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
			}
			return id;
		});

		if (replacedInodeId !== null) this.#contentCache.delete(replacedInodeId);
		this.#contentCache.set(inodeId, fullBytes);
		this.#pathCache.set(path, {
			inodeId,
			kind: 1,
			mode: 0o644,
			size: fullBytes.length,
			mtime,
			contentSha256: sha256,
			symlinkTarget: null,
		});
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const recursive = options?.recursive ?? false;
		const mtime = new Date();

		if (recursive) {
			// Walk from root, creating missing segments
			const segments = path.split("/").filter(Boolean);
			let current = "/";
			for (const seg of segments) {
				const next = current === "/" ? `/${seg}` : `${current}/${seg}`;
				if (!this.#pathCache.has(next)) {
					const parentEntry = this.#pathCache.get(current);
					if (!parentEntry) throw createEnoent(current);
					const inodeId = await this.#withTx(async (tx) => {
						const id = await this.#dialect.createInode(tx, {
							sandboxId: this.#sandboxId,
							kind: 2,
							mode: 0o755,
							size: 0,
						});
						await this.#dialect.insertDirent(tx, parentEntry.inodeId, seg, id);
						return id;
					});
					this.#pathCache.set(next, {
						inodeId,
						kind: 2,
						mode: 0o755,
						size: 0,
						mtime,
						contentSha256: null,
						symlinkTarget: null,
					});
				}
				current = next;
			}
			return;
		}

		// Non-recursive
		if (this.#pathCache.has(path)) throw createEexist(path);
		const parentPath = this.#parentOf(path);
		const name = this.#nameOf(path);
		const parentEntry = this.#pathCache.get(parentPath);
		if (!parentEntry) throw createEnoent(parentPath);
		if (parentEntry.kind !== 2) throw createEnotdir(parentPath);

		const inodeId = await this.#withTx(async (tx) => {
			const id = await this.#dialect.createInode(tx, {
				sandboxId: this.#sandboxId,
				kind: 2,
				mode: 0o755,
				size: 0,
			});
			await this.#dialect.insertDirent(tx, parentEntry.inodeId, name, id);
			return id;
		});

		this.#pathCache.set(path, {
			inodeId,
			kind: 2,
			mode: 0o755,
			size: 0,
			mtime,
			contentSha256: null,
			symlinkTarget: null,
		});
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const entry = this.#pathCache.get(path);

		if (!entry) {
			if (options?.force) return;
			throw createEnoent(path);
		}

		const parentPath = this.#parentOf(path);
		const name = this.#nameOf(path);
		const parentEntry = this.#pathCache.get(parentPath);

		if (options?.recursive && entry.kind === 2) {
			// Snapshot subtree paths before async work
			const subtreePaths = this.#allPathsUnder(path);

			// DB: delete parent dirent + all subtree inodes in one transaction
			await this.#withTx(async (tx) => {
				if (parentEntry) {
					await this.#dialect.deleteDirent(tx, parentEntry.inodeId, name);
				}
				const allInodeIds = await this.#dialect.loadSubtreeInodes(tx, entry.inodeId);
				for (const inodeId of allInodeIds) {
					await this.#dialect.deleteInode(tx, inodeId);
				}
			});

			// Update caches after successful DB operation
			for (const p of subtreePaths) {
				const e = this.#pathCache.get(p);
				if (e) this.#contentCache.delete(e.inodeId);
				this.#pathCache.delete(p);
			}
			return;
		}

		if (entry.kind === 2) {
			// Non-recursive: only allow if empty
			if (this.#childPaths(path).length > 0) throw createEnotempty(path);
		}

		await this.#withTx(async (tx) => {
			const removedInodeId = await this.#dialect.deleteDirent(tx, parentEntry!.inodeId, name);
			const newNlink = await this.#dialect.decrementNlink(tx, removedInodeId);
			if (newNlink === 0) await this.#dialect.deleteInode(tx, removedInodeId);
		});

		this.#contentCache.delete(entry.inodeId);
		this.#pathCache.delete(path);
	}

	async chmod(path: string, mode: number): Promise<void> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		await this.#withTx(async (tx) => {
			await this.#dialect.updateInode(tx, entry.inodeId, { mode });
		});

		this.#pathCache.set(path, { ...entry, mode });
	}

	async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		await this.#withTx(async (tx) => {
			await this.#dialect.updateInode(tx, entry.inodeId, { mtime });
		});

		this.#pathCache.set(path, { ...entry, mtime });
	}

	// ── IFileSystem: stubs (implemented in later stories) ────────────────────────

	async readFile(path: string, _options?: ReadFileOpts): Promise<string> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind === 2) throw createEisdir(path);

		// Cache hit: return decoded bytes without any DB call
		const cached = this.#contentCache.get(entry.inodeId);
		if (cached !== undefined) {
			return new TextDecoder().decode(cached);
		}

		// Cache miss: fetch blob from DB, populate cache
		const data = await this.#withTx(async (tx) => this.#dialect.getBlob(tx, entry.contentSha256!));
		const bytes = data ?? new Uint8Array(0);
		if (bytes.byteLength > 0) this.#contentCache.set(entry.inodeId, bytes);
		return new TextDecoder().decode(bytes);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind === 2) throw createEisdir(path);

		// Cache hit: return raw bytes without any DB call
		const cached = this.#contentCache.get(entry.inodeId);
		if (cached !== undefined) return cached;

		// Cache miss: fetch blob from DB, populate cache
		const data = await this.#withTx(async (tx) => this.#dialect.getBlob(tx, entry.contentSha256!));
		const bytes = data ?? new Uint8Array(0);
		if (bytes.byteLength > 0) this.#contentCache.set(entry.inodeId, bytes);
		return bytes;
	}

	async exists(path: string): Promise<boolean> {
		return this.#pathCache.has(path);
	}

	async stat(path: string): Promise<FsStat> {
		let entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		// stat follows symlinks at the final component
		if (entry.kind === 3) {
			const target = entry.symlinkTarget ?? "";
			const resolved = this.#pathCache.get(target);
			if (!resolved) throw createEnoent(target);
			entry = resolved;
		}

		return {
			isFile: entry.kind === 1,
			isDirectory: entry.kind === 2,
			isSymbolicLink: false,
			mode: entry.mode,
			size: entry.size,
			mtime: entry.mtime,
		};
	}

	async lstat(path: string): Promise<FsStat> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);

		return {
			isFile: entry.kind === 1,
			isDirectory: entry.kind === 2,
			isSymbolicLink: entry.kind === 3,
			mode: entry.mode,
			size: entry.size,
			mtime: entry.mtime,
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind !== 2) throw createEnotdir(path);
		return this.#childPaths(path).map((p) => this.#nameOf(p));
	}

	readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const entry = this.#pathCache.get(path);
		if (!entry) return Promise.reject(createEnoent(path));
		if (entry.kind !== 2) return Promise.reject(createEnotdir(path));
		const children = this.#childPaths(path);
		const result: DirentEntry[] = children.map((p) => {
			const e = this.#pathCache.get(p)!;
			return {
				name: this.#nameOf(p),
				isFile: e.kind === 1,
				isDirectory: e.kind === 2,
				isSymbolicLink: e.kind === 3,
			};
		});
		return Promise.resolve(result);
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		const srcEntry = this.#pathCache.get(src);
		if (!srcEntry) throw createEnoent(src);

		if (srcEntry.kind === 2) {
			if (!options?.recursive) throw createEisdir(src);

			// Recursive directory copy: walk source subtree, create new inodes sharing same blobs
			const srcPaths = this.#allPathsUnder(src);
			// Sort by depth so parents are always created before their children
			srcPaths.sort((a, b) => a.split("/").length - b.split("/").length);

			const destParentPath = this.#parentOf(dest);
			const destParentEntry = this.#pathCache.get(destParentPath);
			if (!destParentEntry) throw createEnoent(destParentPath);
			if (destParentEntry.kind !== 2) throw createEnotdir(destParentPath);

			const mtime = new Date();
			// Maps destPath → new inodeId so children can look up their parent's new id
			const newInodeIds = new Map<string, bigint>();

			await this.#withTx(async (tx) => {
				for (const srcPath of srcPaths) {
					const entry = this.#pathCache.get(srcPath)!;
					const destPath = dest + srcPath.slice(src.length);
					const entryName = this.#nameOf(destPath);
					const entryParent = this.#parentOf(destPath);

					// Parent is either a newly-created dir (newInodeIds) or an existing pathCache entry
					const parentInodeId = newInodeIds.get(entryParent) ?? this.#pathCache.get(entryParent)?.inodeId;
					if (parentInodeId === undefined) throw createEnoent(entryParent);

					const newId = await this.#dialect.createInode(tx, {
						sandboxId: this.#sandboxId,
						kind: entry.kind,
						mode: entry.mode,
						size: entry.size,
						contentSha256: entry.contentSha256,
						symlinkTarget: entry.symlinkTarget,
					});
					await this.#dialect.insertDirent(tx, parentInodeId, entryName, newId);
					newInodeIds.set(destPath, newId);
				}
			});

			// Update pathCache with all newly-created entries
			for (const [destPath, inodeId] of newInodeIds) {
				const srcPath = src + destPath.slice(dest.length);
				const srcE = this.#pathCache.get(srcPath)!;
				this.#pathCache.set(destPath, { ...srcE, inodeId, mtime });
			}
			return;
		}

		// Single file copy: new inode pointing to the same blob (CAS dedup)
		const destParentPath = this.#parentOf(dest);
		const destName = this.#nameOf(dest);
		const destParentEntry = this.#pathCache.get(destParentPath);
		if (!destParentEntry) throw createEnoent(destParentPath);
		if (destParentEntry.kind !== 2) throw createEnotdir(destParentPath);

		const mtime = new Date();

		const newInodeId = await this.#withTx(async (tx) => {
			const id = await this.#dialect.createInode(tx, {
				sandboxId: this.#sandboxId,
				kind: 1,
				mode: srcEntry.mode,
				size: srcEntry.size,
				contentSha256: srcEntry.contentSha256,
			});
			const oldInodeId = await this.#dialect.upsertDirent(tx, destParentEntry.inodeId, destName, id);
			if (oldInodeId !== null) {
				const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
				if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
			}
			return id;
		});

		this.#pathCache.set(dest, {
			inodeId: newInodeId,
			kind: 1,
			mode: srcEntry.mode,
			size: srcEntry.size,
			mtime,
			contentSha256: srcEntry.contentSha256,
			symlinkTarget: null,
		});
	}

	async mv(src: string, dest: string): Promise<void> {
		const srcEntry = this.#pathCache.get(src);
		if (!srcEntry) throw createEnoent(src);

		const srcParentPath = this.#parentOf(src);
		const srcName = this.#nameOf(src);
		const destParentPath = this.#parentOf(dest);
		const destName = this.#nameOf(dest);

		const srcParentEntry = this.#pathCache.get(srcParentPath);
		if (!srcParentEntry) throw createEnoent(srcParentPath);

		const destParentEntry = this.#pathCache.get(destParentPath);
		if (!destParentEntry) throw createEnoent(destParentPath);

		// Capture displaced dest inode before async work
		const destEntry = this.#pathCache.get(dest);

		await this.#withTx(async (tx) => {
			// If destination exists, decrement nlink on the displaced inode.
			// moveDirent will DELETE the dest dirent in SQL; we handle the inode lifecycle here.
			if (destEntry) {
				const newNlink = await this.#dialect.decrementNlink(tx, destEntry.inodeId);
				if (newNlink === 0) await this.#dialect.deleteInode(tx, destEntry.inodeId);
			}
			await this.#dialect.moveDirent(tx, srcParentEntry.inodeId, srcName, destParentEntry.inodeId, destName);
		});

		// Snapshot src subtree before mutating the cache
		const srcPaths = this.#allPathsUnder(src);
		const snapshot = new Map<string, PathCacheEntry>();
		for (const p of srcPaths) {
			const e = this.#pathCache.get(p);
			if (e) snapshot.set(p, e);
		}

		// Remove src subtree and any existing dest subtree from cache
		for (const p of srcPaths) this.#pathCache.delete(p);
		const destPrefix = dest === "/" ? "/" : `${dest}/`;
		for (const key of [...this.#pathCache.keys()]) {
			if (key === dest || key.startsWith(destPrefix)) this.#pathCache.delete(key);
		}

		// Re-insert src entries under dest (remap prefix src → dest)
		for (const [oldPath, entry] of snapshot) {
			this.#pathCache.set(dest + oldPath.slice(src.length), entry);
		}
	}

	resolvePath(_base: string, _path: string): string {
		throw new Error("not implemented");
	}

	async symlink(_target: string, _linkPath: string): Promise<void> {
		throw new Error("not implemented");
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		const srcEntry = this.#pathCache.get(existingPath);
		if (!srcEntry) throw createEnoent(existingPath);
		if (srcEntry.kind === 2) throw createEperm(existingPath, "link");
		if (this.#pathCache.has(newPath)) throw createEexist(newPath);

		const destParentPath = this.#parentOf(newPath);
		const destName = this.#nameOf(newPath);
		const destParentEntry = this.#pathCache.get(destParentPath);
		if (!destParentEntry) throw createEnoent(destParentPath);
		if (destParentEntry.kind !== 2) throw createEnotdir(destParentPath);

		await this.#withTx(async (tx) => {
			await this.#dialect.insertDirent(tx, destParentEntry.inodeId, destName, srcEntry.inodeId);
			await this.#dialect.incrementNlink(tx, srcEntry.inodeId);
		});

		this.#pathCache.set(newPath, { ...srcEntry });
	}

	async readlink(path: string): Promise<string> {
		const entry = this.#pathCache.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind !== 3) throw createEinval(path);
		return entry.symlinkTarget!;
	}

	async realpath(path: string): Promise<string> {
		const resolvedInodeId = await this.#withTx(async (tx) => this.#dialect.resolvePath(tx, path, true));
		for (const [p, entry] of this.#pathCache) {
			if (entry.inodeId === resolvedInodeId) return p;
		}
		throw createEnoent(path);
	}
}
