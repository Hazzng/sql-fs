import type { Bash, ExecOptions, IFileSystem } from "just-bash";
import type { BulkIngestFile } from "../../sql-fs/types.js";
import type { RuntimeOptions } from "../session-runtime/engine.js";

export type ShellExecutionLimits = NonNullable<NonNullable<ConstructorParameters<typeof Bash>[0]>["executionLimits"]>;

export type AsyncFsMethod = Exclude<keyof IFileSystem, "resolvePath" | "getAllPaths" | "assertFileAccess">;
export type FsCall = {
	[K in AsyncFsMethod]: { readonly kind: K; readonly args: Parameters<NonNullable<IFileSystem[K]>> };
}[AsyncFsMethod];

export interface OwnerIdentity {
	readonly tenantId: string;
	readonly sandboxId: string;
	readonly connectionString: string;
	readonly runtimeOptions: RuntimeOptions;
	readonly owner: string;
	readonly cwd: string;
}

export interface OwnerMetadata {
	readonly owner: string;
	readonly createdAt: string;
	readonly cwd: string;
	readonly dirty: boolean;
	readonly poisoned: boolean;
	readonly pathCacheBytes: number;
}

export type OwnerCommand =
	| { readonly kind: "attach"; readonly identity: OwnerIdentity }
	| FsCall
	| { readonly kind: "exec"; readonly script: string; readonly options: Omit<ExecOptions, "signal"> }
	| { readonly kind: "paths" }
	| { readonly kind: "reload" }
	| { readonly kind: "fresh" }
	| { readonly kind: "bulkIngest"; readonly files: BulkIngestFile[] }
	| { readonly kind: "beginScope" | "endScope" | "abortScope" | "disconnect" | "clearDirty" | "shutdown" };

export interface OwnerRequest {
	readonly id: number;
	readonly generation: number;
	readonly command: OwnerCommand;
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

export function mayApply(command: OwnerCommand): boolean {
	switch (command.kind) {
		case "exec":
		case "writeFile":
		case "appendFile":
		case "mkdir":
		case "createExclusive":
		case "rm":
		case "cp":
		case "mv":
		case "chmod":
		case "symlink":
		case "link":
		case "utimes":
		case "bulkIngest":
		case "endScope":
			return true;
		default:
			return false;
	}
}
