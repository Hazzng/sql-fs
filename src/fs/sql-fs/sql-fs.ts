/**
 * SqlFs: IFileSystem implementation backed by a SQL dialect.
 * Caches the full path tree in memory (pathCache) and file content (contentCache).
 *
 * US-019: pathCache initialization from loadAllPaths
 */

import type { CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";

import type { PathCacheEntry, SqlDialect } from "./types.js";

// Extract optional-parameter types from IFileSystem to avoid importing
// from just-bash internal paths (ReadFileOptions, WriteFileOptions are not
// publicly re-exported from the just-bash main entry point).
type ReadFileOpts = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOpts = Parameters<IFileSystem["writeFile"]>[2];

interface SqlFsOptions<Tx> {
	readonly dialect: SqlDialect<Tx>;
	readonly sandboxId: string;
}

export class SqlFs<Tx = unknown> implements IFileSystem {
	readonly #dialect: SqlDialect<Tx>;
	readonly #sandboxId: string;
	readonly #pathCache: Map<string, PathCacheEntry>;

	constructor(opts: SqlFsOptions<Tx>) {
		this.#dialect = opts.dialect;
		this.#sandboxId = opts.sandboxId;
		this.#pathCache = new Map();
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

	// ── IFileSystem: stubs (implemented in later stories) ────────────────────────

	async readFile(_path: string, _options?: ReadFileOpts): Promise<string> {
		throw new Error("not implemented");
	}

	async readFileBuffer(_path: string): Promise<Uint8Array> {
		throw new Error("not implemented");
	}

	async writeFile(_path: string, _content: FileContent, _options?: WriteFileOpts): Promise<void> {
		throw new Error("not implemented");
	}

	async appendFile(_path: string, _content: FileContent, _options?: WriteFileOpts): Promise<void> {
		throw new Error("not implemented");
	}

	async exists(_path: string): Promise<boolean> {
		throw new Error("not implemented");
	}

	async stat(_path: string): Promise<FsStat> {
		throw new Error("not implemented");
	}

	async lstat(_path: string): Promise<FsStat> {
		throw new Error("not implemented");
	}

	async mkdir(_path: string, _options?: MkdirOptions): Promise<void> {
		throw new Error("not implemented");
	}

	async readdir(_path: string): Promise<string[]> {
		throw new Error("not implemented");
	}

	async rm(_path: string, _options?: RmOptions): Promise<void> {
		throw new Error("not implemented");
	}

	async cp(_src: string, _dest: string, _options?: CpOptions): Promise<void> {
		throw new Error("not implemented");
	}

	async mv(_src: string, _dest: string): Promise<void> {
		throw new Error("not implemented");
	}

	resolvePath(_base: string, _path: string): string {
		throw new Error("not implemented");
	}

	async chmod(_path: string, _mode: number): Promise<void> {
		throw new Error("not implemented");
	}

	async symlink(_target: string, _linkPath: string): Promise<void> {
		throw new Error("not implemented");
	}

	async link(_existingPath: string, _newPath: string): Promise<void> {
		throw new Error("not implemented");
	}

	async readlink(_path: string): Promise<string> {
		throw new Error("not implemented");
	}

	async realpath(_path: string): Promise<string> {
		throw new Error("not implemented");
	}

	async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
		throw new Error("not implemented");
	}
}
