import type { Bash, BashExecResult, ExecOptions, IFileSystem } from "just-bash";
import type { BulkIngestFile } from "../../sql-fs/types.js";
import type { RuntimeOptions } from "../session-runtime/engine.js";

export type ShellExecutionLimits = NonNullable<NonNullable<ConstructorParameters<typeof Bash>[0]>["executionLimits"]>;

export type AsyncFsMethod =
	| "readFile"
	| "readFileBuffer"
	| "readFileBytes"
	| "writeFile"
	| "appendFile"
	| "exists"
	| "stat"
	| "mkdir"
	| "createExclusive"
	| "readdir"
	| "readdirWithFileTypes"
	| "rm"
	| "cp"
	| "mv"
	| "chmod"
	| "symlink"
	| "link"
	| "readlink"
	| "lstat"
	| "realpath"
	| "utimes";

type FsCommandMap = {
	[K in AsyncFsMethod]: {
		payload: { readonly args: Parameters<NonNullable<IFileSystem[K]>> };
		result: Awaited<ReturnType<NonNullable<IFileSystem[K]>>>;
	};
};

export interface OwnerIdentity {
	readonly tenantId: string;
	readonly sandboxId: string;
	readonly connectionString: string;
	readonly runtimeOptions: RuntimeOptions;
	readonly owner: string;
	readonly cwd: string;
	readonly openExisting?: boolean;
}

export interface OwnerMetadata {
	readonly owner: string;
	readonly createdAt: string;
	readonly cwd: string;
	readonly dirty: boolean;
	readonly poisoned: boolean;
	readonly pathCacheBytes: number;
}

type CommandSpec<Payload, Result> = { payload: Payload; result: Result };

export type OwnerCommandMap = FsCommandMap & {
	attach: CommandSpec<{ readonly identity: OwnerIdentity }, void>;
	exec: CommandSpec<{ readonly script: string; readonly options: Omit<ExecOptions, "signal"> }, BashExecResult>;
	paths: CommandSpec<Record<never, never>, string[]>;
	reload: CommandSpec<Record<never, never>, void>;
	fresh: CommandSpec<Record<never, never>, boolean>;
	runtime: CommandSpec<{ readonly runtimeOptions: RuntimeOptions }, void>;
	bulkIngest: CommandSpec<{ readonly files: BulkIngestFile[] }, void>;
	beginScope: CommandSpec<Record<never, never>, void>;
	endScope: CommandSpec<Record<never, never>, void>;
	abortScope: CommandSpec<Record<never, never>, void>;
	disconnect: CommandSpec<Record<never, never>, void>;
	clearDirty: CommandSpec<Record<never, never>, void>;
	shutdown: CommandSpec<Record<never, never>, void>;
};

export type OwnerCommandKind = keyof OwnerCommandMap;
export type OwnerCommand<K extends OwnerCommandKind = OwnerCommandKind> = {
	[P in K]: { readonly kind: P } & OwnerCommandMap[P]["payload"];
}[K];
export type OwnerResult<K extends OwnerCommandKind> = OwnerCommandMap[K]["result"];
export type FsCall = OwnerCommand<AsyncFsMethod>;

export type OwnerHandlers = {
	[K in OwnerCommandKind]: (
		command: OwnerCommand<K>,
		request: OwnerRequest,
		signal: AbortSignal,
	) => Promise<OwnerResult<K>>;
};

export type OwnerEffectPolicy = {
	[K in OwnerCommandKind]: (command: OwnerCommand<K>) => boolean;
};

export interface OwnerRequest<K extends OwnerCommandKind = OwnerCommandKind> {
	readonly id: number;
	readonly generation: number;
	readonly command: OwnerCommand<K>;
	readonly readOnly: boolean;
	readonly cancellation: SharedArrayBuffer;
}

export interface OwnerFailure {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
}

export type OwnerReply = {
	readonly id: number;
	readonly generation: number;
	readonly metadata?: OwnerMetadata;
	readonly readOnlyViolated: boolean;
	readonly memory: { readonly heapUsed: number; readonly external: number; readonly rss: number };
} & ({ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: OwnerFailure });

export type OwnerEvent = OwnerReply | { readonly kind: "ready" };

export class WorkerBusyError extends Error {
	readonly code = "EWORKER_BUSY";
	constructor() {
		super("EWORKER_BUSY: execution capacity is busy; retry after a short delay");
	}
}

export class OutcomeUnknownError extends Error {
	readonly code = "EEXEC_OUTCOME_UNKNOWN";
	constructor(
		message = "EEXEC_OUTCOME_UNKNOWN: the worker stopped after dispatch; the write outcome is unknown; do not replay the script",
	) {
		super(message);
	}
}

const commandEffects: OwnerEffectPolicy = {
	attach: (command) => command.identity.openExisting !== true,
	exec: () => true,
	readFile: () => false,
	readFileBuffer: () => false,
	readFileBytes: () => false,
	writeFile: () => true,
	appendFile: () => true,
	exists: () => false,
	stat: () => false,
	mkdir: () => true,
	createExclusive: () => true,
	readdir: () => false,
	readdirWithFileTypes: () => false,
	rm: () => true,
	cp: () => true,
	mv: () => true,
	chmod: () => true,
	symlink: () => true,
	link: () => true,
	readlink: () => false,
	lstat: () => false,
	realpath: () => false,
	utimes: () => true,
	paths: () => false,
	reload: () => false,
	fresh: () => false,
	runtime: () => false,
	bulkIngest: () => true,
	beginScope: () => false,
	endScope: () => true,
	abortScope: () => false,
	disconnect: () => false,
	clearDirty: () => false,
	shutdown: () => false,
};

export function mayApply<K extends OwnerCommandKind>(command: OwnerCommand<K>): boolean {
	return commandEffects[command.kind](command);
}
