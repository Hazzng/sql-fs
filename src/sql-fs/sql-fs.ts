import {
	type ByteString,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
	unsafeBytesFromLatin1,
} from "just-bash";
import type { LRUCache } from "lru-cache";

import { LockLostError } from "../api/distributed-lock.js";
import { consumeExecInput, execContext } from "../api/exec-context.js";
import { readOnlyContext } from "../api/read-only-context.js";
import { ownerLeaseLost } from "../execution/owner-cancellation.js";
import {
	createEexist,
	createEfbig,
	createEinval,
	createEisdir,
	createEnoent,
	createEnotdir,
	createEperm,
	createEreadonly,
} from "./errors.js";
import type { ScriptTxBufferConfig } from "./script-tx-buffer.js";
import { type BulkIngestFile, INODE_KIND, type PathCacheEntry, type SqlDialect } from "./types.js";

/**
 * `stat().identity`: just-bash 3.6's mv/cp refuse to replace an existing target unless they can
 * prove it is a different file. Buffered placeholder ids are negative and real ids positive, so
 * an id is unique within a scope, which is as long as one mv/cp compares them.
 */
function inodeIdentity(inodeId: bigint): string {
	return inodeId.toString();
}

// just-bash seeds /dev only through sync fs methods, which SqlFs lacks, and routes
// `> /dev/null` through the fs (vercel-labs/just-bash#558). Serving it virtually keeps
// discarded output out of the journal and the DB.

const DEV_NULL_STAT: FsStat = {
	isFile: true,
	isDirectory: false,
	isSymbolicLink: false,
	mode: 0o666,
	size: 0,
	mtime: new Date(0),
	identity: DEV_NULL,
};

// Extract optional-parameter types from IFileSystem to avoid importing
// from just-bash internal paths (ReadFileOptions, WriteFileOptions, DirentEntry are not
// publicly re-exported from the just-bash main entry point).
type ReadFileOpts = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOpts = Parameters<IFileSystem["writeFile"]>[2];
type CreateExclusiveOpts = Parameters<NonNullable<IFileSystem["createExclusive"]>>[1];
type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>>[number];

function encodeContent(content: FileContent, options: WriteFileOpts): Uint8Array {
	if (typeof content !== "string") return content;
	const encoding = (typeof options === "string" ? options : options?.encoding) ?? "utf8";
	return new Uint8Array(Buffer.from(content, encoding));
}

export const DEFAULT_CONTENT_CACHE_MAX_BYTES = 50 * 1024 * 1024;

interface SqlFsOptions<Tx> {
	readonly dialect: SqlDialect<Tx>;
	readonly sandboxId: string;
	/** Max total byte budget for the content cache. Default: 50 MB. */
	readonly contentCacheMaxBytes?: number;
	/** Allow symbolic links. Defaults to true. */
	readonly allowSymlinks?: boolean;
	/**
	 * Buffered script-tx (#166). When enabled, mutations inside a script scope are
	 * recorded and replayed in one short transaction at `endScriptScope` instead of
	 * running on a transaction held open across the user's script.
	 *
	 * Defaults to DISABLED here so a bare `new SqlFs(...)` keeps the legacy shape;
	 * the deployment default (on) is applied by `createPostgresSandboxFs`, next to
	 * the other env reads.
	 */
	readonly scriptTxBuffer?: ScriptTxBufferConfig;
}

/**
 * Narrow extension of `IFileSystem` with cache-coherence affordances used by
 * `SessionManager` for cross-replica reload-on-handoff (Phase D).
 *
 * `SqlFs` satisfies this interface. The `memory` backend (InMemoryFs) does
 * NOT — call sites must guard via `"reload" in fs` before casting.
 */
export interface ICoherentFs extends IFileSystem {
	setOwnerLeaseGuard?(guard: () => void): void;
	claimGeneration?(): Promise<boolean>;
	/** Drops all in-memory caches and repopulates from the source of truth. */
	reload(): Promise<void>;
	/** Resolves true when it loaded a new committed view. */
	ensureFresh(): Promise<boolean>;
	/** True iff at least one mutation has run since the last clearDirty. */
	wasDirty(): boolean;
	/** Resets the dirty flag after session memory accounting. */
	clearDirty(): void | Promise<void>;
	/**
	 * True iff a recovery `reload()` failed after a transaction COMMIT/abort,
	 * leaving the in-memory caches holding mutations that never committed to the
	 * source of truth. Admission must reload even if the epoch is unchanged.
	 */
	poisoned(): boolean;
	/**
	 * Bulk-inserts files into the sandbox in minimal DB round-trips, creating
	 * any missing parent directories. After commit, repopulates the in-memory
	 * pathCache via reload() and marks the FS dirty.
	 */
	bulkIngest(files: BulkIngestFile[]): Promise<void>;
}

export interface IScriptTxFs extends ICoherentFs {
	beginScriptScope(): void;
	endScriptScope(): Promise<void>;
	abortScriptScope(): Promise<void>;
	readonly scriptScopeActive: boolean;
	readonly scriptTxOpen: boolean;
}

/**
 * Read-only scope hooks used by the parallel-readOnly bash exec path. While
 * the scope is active every mutating method on the filesystem throws
 * EREADONLY immediately — the offending bash command fails fast and no
 * partial state escapes to other concurrent readers.
 *
 * Reference-counted: every concurrent reader calls `beginReadOnlyScope`
 * on entry and `endReadOnlyScope` on exit. The scope stays active while
 * any reader holds it. Violation attribution is per-call via the
 * `readOnlyContext` AsyncLocalStorage rather than an FS-level flag, so
 * a lying script in one reader cannot falsely flag innocent readers
 * sharing the same FS.
 */
export interface IReadOnlyScopeFs extends IFileSystem {
	beginReadOnlyScope(): void;
	endReadOnlyScope(): void;
	readonly readOnlyScopeActive: boolean;
}

import { CoherentView } from "./state/coherent-view.js";
import { NamespaceOperations } from "./state/namespace-operations.js";
import { assertStoredPath, DEV_NULL, nameOf, normalizeFsPath, validatePath } from "./state/paths.js";
import { ScriptPersistence } from "./state/script-persistence.js";
export class SqlFs<Tx = unknown> implements ICoherentFs, IReadOnlyScopeFs {
	readonly #dialect: SqlDialect<Tx>;

	readonly #sandboxId: string;

	readonly #allowSymlinks: boolean;

	#readOnlyDepth = 0;

	#ownerLeaseGuard: (() => void) | undefined;

	readonly #persistence: ScriptPersistence<Tx>;

	readonly #view: CoherentView<Tx>;

	readonly #namespace: NamespaceOperations<Tx>;

	constructor(opts: SqlFsOptions<Tx>) {
		this.#dialect = opts.dialect;
		this.#sandboxId = opts.sandboxId;
		this.#allowSymlinks = opts.allowSymlinks ?? true;
		this.#persistence = new ScriptPersistence(
			opts.dialect,
			opts.sandboxId,
			opts.scriptTxBuffer ?? { enabled: false, maxOps: 0, maxBytes: 0 },
			() => this.#assertOwnerLease(),
		);
		this.#view = new CoherentView(
			opts.dialect,
			opts.dialect,
			opts.sandboxId,
			this.#persistence,
			opts.contentCacheMaxBytes ?? DEFAULT_CONTENT_CACHE_MAX_BYTES,
		);
		this.#namespace = new NamespaceOperations(opts.dialect, opts.sandboxId, this.#view, this.#persistence, {
			assertWritable: (path, op) => this.#assertWritable(path, op),
			assertWriteSize: (path, bytes) => this.#assertExecFileSize(path, bytes, "write"),
			chargeAppendInput: (path, bytes) => consumeExecInput(execContext.getStore(), bytes, path),
			assertSymlink: (target, path) => {
				if (target.includes("\0")) throw createEinval(target);
				if (!this.#allowSymlinks) throw createEperm(path, "symlink");
			},
		});
	}

	_getPathCache(): Map<string, PathCacheEntry> {
		return this.#view._getPathCache();
	}

	_getContentCache(): LRUCache<bigint, Uint8Array> {
		return this.#view._getContentCache();
	}

	wasDirty(): boolean {
		return this.#view.wasDirty();
	}

	clearDirty(): void {
		this.#view.clearDirty();
	}

	poisoned(): boolean {
		return this.#view.poisoned();
	}

	getPathCacheBytes(): number {
		return this.#view.pathCacheBytes;
	}

	getAllPaths(): string[] {
		this.#persistence.assertAlive();
		return this.#view.paths();
	}

	ready(): Promise<void> {
		return this.#view.ready();
	}

	reload(): Promise<void> {
		return this.#view.reload();
	}

	ensureFresh(): Promise<boolean> {
		return this.#view.ensureFresh();
	}

	get scriptScopeActive(): boolean {
		return this.#persistence.scopeActive;
	}

	get scriptTxOpen(): boolean {
		return this.#persistence.transactionOpen;
	}

	beginScriptScope(): void {
		this.#persistence.begin();
	}

	async claimGeneration(): Promise<boolean> {
		const certificate = await this.#persistence.claimGeneration();
		if (certificate === undefined || this.#view.publishGeneration(certificate)) return false;
		await this.reload();
		return true;
	}

	async disconnect(): Promise<void> {
		await this.#dialect.disconnect();
	}

	setOwnerLeaseGuard(guard: () => void): void {
		this.#ownerLeaseGuard = guard;
	}

	#assertOwnerLease(): void {
		this.#ownerLeaseGuard?.();
		if (ownerLeaseLost()) throw new LockLostError("worker owner generation");
	}

	get readOnlyScopeActive(): boolean {
		return this.#readOnlyDepth > 0;
	}

	beginReadOnlyScope(): void {
		this.#readOnlyDepth++;
	}

	endReadOnlyScope(): void {
		if (this.#readOnlyDepth === 0) {
			throw new Error("endReadOnlyScope: no active read-only scope");
		}
		this.#readOnlyDepth--;
	}

	#assertExecFileSize(path: string, bytes: number, op: "read" | "write"): void {
		const ctx = execContext.getStore();
		if (ctx === undefined || ctx.maxFileBytes === null || bytes <= ctx.maxFileBytes) return;
		const err = createEfbig(path, bytes, ctx.maxFileBytes, op);
		// Recorded as well as thrown: bash swallows a read rejection into a phantom
		// "No such file or directory". See ExecContext.exceeded.
		if (ctx.exceeded === undefined) ctx.exceeded = err;
		throw err;
	}

	assertFileAccess(inputPath: string, bytes: number, op: "read" | "write"): void {
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return;
		if (op === "write") this.#assertWritable(path, "writeFile");
		else this.#persistence.assertAlive();
		this.#assertExecFileSize(path, bytes, op);
	}

	#assertWritable(path: string, op: string): void {
		this.#persistence.assertAlive();
		if (this.#readOnlyDepth > 0) {
			const ctx = readOnlyContext.getStore();
			if (ctx !== undefined) ctx.violated = true;
			throw createEreadonly(path, op);
		}
	}

	async readFile(inputPath: string, _options?: ReadFileOpts): Promise<string> {
		this.#persistence.assertAlive();
		return new TextDecoder().decode(await this.#readBytes(inputPath));
	}

	async readFileBuffer(inputPath: string): Promise<Uint8Array> {
		this.#persistence.assertAlive();
		return this.#readBytes(inputPath);
	}

	async readFileBytes(inputPath: string): Promise<ByteString> {
		this.#persistence.assertAlive();
		const bytes = await this.#readBytes(inputPath);
		return unsafeBytesFromLatin1(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"));
	}

	async exists(inputPath: string): Promise<boolean> {
		this.#persistence.assertAlive();
		const path = validatePath(inputPath);
		return path === DEV_NULL || this.#view.has(path);
	}

	async stat(inputPath: string): Promise<FsStat> {
		this.#persistence.assertAlive();
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return { ...DEV_NULL_STAT };

		// Use the same resolver as reads, including relative/chained aliases to the device.
		const entry = await this.#view.resolveReadEntry(path);
		if (entry === null) return { ...DEV_NULL_STAT };

		return {
			isFile: entry.kind === INODE_KIND.FILE,
			isDirectory: entry.kind === INODE_KIND.DIRECTORY,
			isSymbolicLink: false,
			mode: entry.mode,
			size: entry.size,
			mtime: entry.mtime,
			identity: inodeIdentity(entry.inodeId),
		};
	}

	async lstat(inputPath: string): Promise<FsStat> {
		this.#persistence.assertAlive();
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return { ...DEV_NULL_STAT };
		const entry = this.#view.get(path);
		if (!entry) throw createEnoent(path);

		return {
			isFile: entry.kind === INODE_KIND.FILE,
			isDirectory: entry.kind === INODE_KIND.DIRECTORY,
			isSymbolicLink: entry.kind === INODE_KIND.SYMLINK,
			mode: entry.mode,
			size: entry.size,
			mtime: entry.mtime,
			identity: inodeIdentity(entry.inodeId),
		};
	}

	async readdir(inputPath: string): Promise<string[]> {
		this.#persistence.assertAlive();
		const path = validatePath(inputPath);
		if (path === DEV_NULL) throw createEnotdir(path);
		const entry = this.#view.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(path);
		return this.#view.childPaths(path).map((p) => nameOf(p));
	}

	readdirWithFileTypes(inputPath: string): Promise<DirentEntry[]> {
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return Promise.reject(createEnotdir(path));
		const entry = this.#view.get(path);
		if (!entry) return Promise.reject(createEnoent(path));
		if (entry.kind !== INODE_KIND.DIRECTORY) return Promise.reject(createEnotdir(path));
		const children = this.#view.childPaths(path);
		const result: DirentEntry[] = children.map((p) => {
			const e = this.#view.get(p)!;
			return {
				name: nameOf(p),
				isFile: e.kind === INODE_KIND.FILE,
				isDirectory: e.kind === INODE_KIND.DIRECTORY,
				isSymbolicLink: e.kind === INODE_KIND.SYMLINK,
			};
		});
		return Promise.resolve(result);
	}

	async readlink(inputPath: string): Promise<string> {
		const path = validatePath(inputPath);
		if (path === DEV_NULL) throw createEinval(path);
		const entry = this.#view.get(path);
		if (!entry) throw createEnoent(path);
		if (entry.kind !== INODE_KIND.SYMLINK) throw createEinval(path);
		return entry.symlinkTarget!;
	}

	resolvePath(base: string, path: string): string {
		if (path.startsWith("/")) return normalizeFsPath(path);
		const combined = base === "/" ? `/${path}` : `${base}/${path}`;
		return normalizeFsPath(combined);
	}

	async #readBytes(inputPath: string): Promise<Uint8Array> {
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return new Uint8Array(0);
		// #resolveReadEntry follows symlinks; ENOENT/ELOOP propagate naturally
		const entry = await this.#view.resolveReadEntry(path);
		if (entry === null) return new Uint8Array(0);
		if (entry.kind === INODE_KIND.DIRECTORY) throw createEisdir(path);
		// Before the cache lookup on purpose: a warm cache makes the DB round trip free
		// but not the megabytes of string work the caller is about to do with the bytes.
		this.#assertExecFileSize(path, entry.size, "read");
		consumeExecInput(execContext.getStore(), entry.size, path);

		return this.#view.readBytes(path, entry);
	}

	async realpath(inputPath: string): Promise<string> {
		this.#persistence.assertAlive();
		return this.#view.realpath(validatePath(inputPath));
	}

	async writeFile(inputPath: string, content: FileContent, options?: WriteFileOpts): Promise<void> {
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return;
		const bytes = encodeContent(content, options);
		await this.#namespace.writeFile(path, bytes, undefined);
	}

	async appendFile(inputPath: string, content: FileContent, options?: WriteFileOpts): Promise<void> {
		const path = validatePath(inputPath);
		if (path === DEV_NULL) return;
		const bytes = encodeContent(content, options);
		await this.#namespace.appendFile(path, bytes);
	}

	async rm(inputPath: string, options?: RmOptions): Promise<void> {
		const path = validatePath(inputPath);
		assertStoredPath(path, "rm");
		await this.#namespace.rm(path, options);
	}

	async chmod(inputPath: string, mode: number): Promise<void> {
		const path = validatePath(inputPath);
		assertStoredPath(path, "chmod");
		await this.#namespace.chmod(path, mode);
	}

	async utimes(inputPath: string, _atime: Date, mtime: Date): Promise<void> {
		const path = validatePath(inputPath);
		assertStoredPath(path, "utimes");
		await this.#namespace.utimes(path, mtime);
	}

	async cp(inputSrc: string, inputDest: string, options?: CpOptions): Promise<void> {
		const src = validatePath(inputSrc);
		const dest = validatePath(inputDest);
		await this.#namespace.cp(src, dest, options);
	}

	async mv(inputSrc: string, inputDest: string): Promise<void> {
		const src = validatePath(inputSrc);
		const dest = validatePath(inputDest);
		assertStoredPath(src, "mv");
		assertStoredPath(dest, "mv");
		await this.#namespace.mv(src, dest);
	}

	async symlink(target: string, inputLinkPath: string): Promise<void> {
		const linkPath = validatePath(inputLinkPath);
		if (linkPath === DEV_NULL) throw createEexist(linkPath);
		await this.#namespace.symlink(target, linkPath);
	}

	async link(inputExistingPath: string, inputNewPath: string): Promise<void> {
		const existingPath = validatePath(inputExistingPath);
		const newPath = validatePath(inputNewPath);
		assertStoredPath(existingPath, "link");
		if (newPath === DEV_NULL) throw createEexist(newPath);
		await this.#namespace.link(existingPath, newPath);
	}

	async createExclusive(inputPath: string, options: CreateExclusiveOpts): Promise<void> {
		return this.#namespace.createExclusive(validatePath(inputPath), options);
	}

	async mkdir(inputPath: string, options?: MkdirOptions): Promise<void> {
		return this.#namespace.mkdir(validatePath(inputPath), options);
	}

	async bulkIngest(files: BulkIngestFile[]): Promise<void> {
		if (files.length === 0) return;
		const seen = new Set<string>();
		const normalized = files.map((file) => {
			const path = validatePath(file.path);
			assertStoredPath(path, "bulkIngest");
			if (seen.has(path)) throw createEexist(path);
			seen.add(path);
			return { ...file, path };
		});
		await this.#namespace.bulkIngest(normalized);
	}

	async #recoverCommittedView(): Promise<void> {
		try {
			await this.reload();
			this.clearDirty();
		} catch {
			this.#view.poison();
		}
	}

	async endScriptScope(): Promise<void> {
		if (!this.#persistence.scopeActive) return;
		if (ownerLeaseLost()) {
			await this.abortScriptScope();
			throw new LockLostError("worker owner before flush");
		}
		try {
			this.#persistence.assertAlive();
		} catch (lost) {
			await this.abortScriptScope();
			throw lost;
		}
		const settlement = await this.#persistence.finish(this.#view);
		if (settlement.kind === "failed") {
			if (settlement.reloadRequired) await this.#recoverCommittedView();
			throw settlement.error;
		}
		if (settlement.kind === "committed") {
			try {
				this.#view.publishScope(settlement);
			} catch (error) {
				await this.#recoverCommittedView();
				throw error;
			}
		}
	}

	async abortScriptScope(): Promise<void> {
		const recovery = await this.#persistence.abort();
		if (recovery.reloadRequired) {
			try {
				await this.reload();
				this.clearDirty();
			} catch (error) {
				this.#view.poison();
				console.error(
					JSON.stringify({
						event: "abort_scope_reload_error",
						sandboxId: this.#sandboxId,
						error: (error as Error).message,
					}),
				);
			}
		}
	}
}
