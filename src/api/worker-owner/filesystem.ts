import path from "node:path";
import type { IFileSystem } from "just-bash";
import { type ScriptScope, runInScriptScope } from "../../sql-fs/script-scope.js";
import type { ICoherentFs } from "../../sql-fs/sql-fs.js";
import type { BulkIngestFile } from "../../sql-fs/types.js";
import type { WorkerOwnerPool } from "./pool.js";
import type { OwnerCommand, OwnerCommandKind, OwnerResult } from "./protocol.js";

export class WorkerFileSystem implements ICoherentFs {
	private dirty = false;
	private cachePoisoned = false;
	private pathBytes = 0;

	constructor(
		private readonly pool: WorkerOwnerPool,
		private readonly key: string,
	) {}

	async call<K extends OwnerCommandKind>(command: OwnerCommand<K>): Promise<OwnerResult<K>> {
		try {
			return await this.pool.send(command);
		} finally {
			this.refreshMetadata();
		}
	}

	refreshMetadata(): void {
		const metadata = this.pool.metadata;
		if (metadata === undefined) return;
		this.dirty = metadata.dirty;
		this.cachePoisoned = metadata.poisoned;
		this.pathBytes = metadata.pathCacheBytes;
	}

	readFile(...args: Parameters<IFileSystem["readFile"]>): ReturnType<IFileSystem["readFile"]> {
		return this.call({ kind: "readFile", args });
	}
	readFileBuffer(...args: Parameters<IFileSystem["readFileBuffer"]>): ReturnType<IFileSystem["readFileBuffer"]> {
		return this.call({ kind: "readFileBuffer", args });
	}
	writeFile(...args: Parameters<IFileSystem["writeFile"]>): ReturnType<IFileSystem["writeFile"]> {
		return this.call({ kind: "writeFile", args });
	}
	appendFile(...args: Parameters<IFileSystem["appendFile"]>): ReturnType<IFileSystem["appendFile"]> {
		return this.call({ kind: "appendFile", args });
	}
	exists(...args: Parameters<IFileSystem["exists"]>): ReturnType<IFileSystem["exists"]> {
		return this.call({ kind: "exists", args });
	}
	stat(...args: Parameters<IFileSystem["stat"]>): ReturnType<IFileSystem["stat"]> {
		return this.call({ kind: "stat", args });
	}
	mkdir(...args: Parameters<IFileSystem["mkdir"]>): ReturnType<IFileSystem["mkdir"]> {
		return this.call({ kind: "mkdir", args });
	}
	createExclusive(...args: Parameters<NonNullable<IFileSystem["createExclusive"]>>): Promise<void> {
		return this.call({ kind: "createExclusive", args });
	}
	readdir(...args: Parameters<IFileSystem["readdir"]>): ReturnType<IFileSystem["readdir"]> {
		return this.call({ kind: "readdir", args });
	}
	readdirWithFileTypes(
		...args: Parameters<NonNullable<IFileSystem["readdirWithFileTypes"]>>
	): ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>> {
		return this.call({ kind: "readdirWithFileTypes", args });
	}
	rm(...args: Parameters<IFileSystem["rm"]>): ReturnType<IFileSystem["rm"]> {
		return this.call({ kind: "rm", args });
	}
	cp(...args: Parameters<IFileSystem["cp"]>): ReturnType<IFileSystem["cp"]> {
		return this.call({ kind: "cp", args });
	}
	mv(...args: Parameters<IFileSystem["mv"]>): ReturnType<IFileSystem["mv"]> {
		return this.call({ kind: "mv", args });
	}
	chmod(...args: Parameters<IFileSystem["chmod"]>): ReturnType<IFileSystem["chmod"]> {
		return this.call({ kind: "chmod", args });
	}
	symlink(...args: Parameters<IFileSystem["symlink"]>): ReturnType<IFileSystem["symlink"]> {
		return this.call({ kind: "symlink", args });
	}
	link(...args: Parameters<IFileSystem["link"]>): ReturnType<IFileSystem["link"]> {
		return this.call({ kind: "link", args });
	}
	readlink(...args: Parameters<IFileSystem["readlink"]>): ReturnType<IFileSystem["readlink"]> {
		return this.call({ kind: "readlink", args });
	}
	lstat(...args: Parameters<IFileSystem["lstat"]>): ReturnType<IFileSystem["lstat"]> {
		return this.call({ kind: "lstat", args });
	}
	realpath(...args: Parameters<IFileSystem["realpath"]>): ReturnType<IFileSystem["realpath"]> {
		return this.call({ kind: "realpath", args });
	}
	utimes(...args: Parameters<IFileSystem["utimes"]>): ReturnType<IFileSystem["utimes"]> {
		return this.call({ kind: "utimes", args });
	}
	resolvePath(base: string, target: string): string {
		return path.posix.resolve(base, target);
	}
	getAllPaths(): string[] {
		throw new Error("worker paths require SessionManager.getSessionPaths");
	}
	getPaths(): Promise<string[]> {
		return this.call({ kind: "paths" });
	}
	reload(): Promise<void> {
		return this.call({ kind: "reload" });
	}
	ensureFresh(): Promise<boolean> {
		return this.call({ kind: "fresh" });
	}
	wasDirty(): boolean {
		return this.dirty;
	}
	poisoned(): boolean {
		return this.cachePoisoned;
	}
	clearDirty(): Promise<void> {
		return this.call({ kind: "clearDirty" });
	}
	getPathCacheBytes(): number {
		return this.pathBytes;
	}
	bulkIngest(files: BulkIngestFile[]): Promise<void> {
		return this.call({ kind: "bulkIngest", files });
	}
	disconnect(): Promise<void> {
		return this.pool.disconnect(this.key);
	}
}

export class WorkerScriptScope implements ScriptScope {
	private active = false;
	constructor(private readonly fs: WorkerFileSystem) {}
	get isActive(): boolean {
		return this.active;
	}
	async beginScope(): Promise<void> {
		if (this.active) return;
		await this.fs.call({ kind: "beginScope" });
		this.active = true;
	}
	async endScope(): Promise<void> {
		if (!this.active) return;
		try {
			await this.fs.call({ kind: "endScope" });
		} finally {
			this.active = false;
		}
	}
	async abortScope(): Promise<void> {
		if (!this.active) return;
		try {
			await this.fs.call({ kind: "abortScope" });
		} finally {
			this.active = false;
		}
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		return runInScriptScope(this, fn);
	}
}
