export type FileKind = "file" | "dir" | "symlink";
export type StreamEventType = "stdout" | "stderr" | "exit";

/** Python runtime selection. null = no Python. */
export type PythonRuntime = "stdlib" | "pyodide" | null;

export interface SandboxRecord {
	id: string;
	name: string | null;
	owner: string;
	createdAt: string;
	python_runtime: PythonRuntime;
	javascript: boolean;
	network: boolean;
}

export interface SandboxInfo {
	id: string;
	name: string | null;
	owner: string;
	createdAt: string;
	lastUsedAt: string;
}

export interface TreeEntry {
	path: string;
	kind: FileKind;
	size: number;
	mtime: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	exitSignal?: string | null;
	timedOut: boolean;
	durationMs: number;
	readonly ok: boolean;
	readonly error: string;
}

export interface BatchExecResult {
	id: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	error?: string;
	readonly ok: boolean;
}

export interface StreamEvent {
	type: StreamEventType;
	data?: string;
	t?: number;
	exitCode?: number;
	durationMs?: number;
	error?: string;
}

export interface FileStat {
	kind: FileKind;
	mode: number;
	size: number;
	mtime: string;
}

export class ReadResult {
	readonly content: Uint8Array;
	readonly stat?: FileStat;

	constructor(content: Uint8Array, stat?: FileStat) {
		this.content = content;
		this.stat = stat;
	}

	text(encoding = "utf-8"): string {
		return new TextDecoder(encoding).decode(this.content);
	}
}

type ApiObject = Record<string, unknown>;

/** Validate the server's python_runtime instead of blindly asserting the type. */
function toPythonRuntime(value: unknown): PythonRuntime {
	if (value == null) return null;
	if (value === "stdlib" || value === "pyodide") return value;
	throw Object.assign(new Error(`unexpected python_runtime from server: ${JSON.stringify(value)}`), {
		code: "EINVALID_PYTHON_RUNTIME",
	});
}

export function sandboxRecordFromApi(payload: ApiObject): SandboxRecord {
	return {
		id: String(payload.id),
		name: payload.name == null ? null : String(payload.name),
		owner: String(payload.owner),
		createdAt: String(payload.createdAt),
		python_runtime: toPythonRuntime(payload.python_runtime),
		javascript: Boolean(payload.javascript),
		network: Boolean(payload.network),
	};
}

export function sandboxInfoFromApi(payload: ApiObject): SandboxInfo {
	return {
		id: String(payload.id),
		name: payload.name == null ? null : String(payload.name),
		owner: String(payload.owner),
		createdAt: String(payload.createdAt),
		lastUsedAt: String(payload.lastUsedAt),
	};
}

export function treeEntryFromApi(payload: ApiObject): TreeEntry {
	return {
		path: String(payload.path),
		kind: payload.kind as FileKind,
		size: Number(payload.size),
		mtime: String(payload.mtime),
	};
}

export function fileStatFromApi(payload: ApiObject): FileStat {
	return {
		kind: payload.kind as FileKind,
		mode: Number(payload.mode),
		size: Number(payload.size),
		mtime: String(payload.mtime),
	};
}

export function execResultFromApi(payload: ApiObject): ExecResult {
	const exitCode = Number(payload.exitCode);
	const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
	return {
		stdout: typeof payload.stdout === "string" ? payload.stdout : "",
		stderr,
		exitCode,
		exitSignal: typeof payload.exitSignal === "string" ? payload.exitSignal : null,
		timedOut: Boolean(payload.timedOut),
		durationMs: Number(payload.durationMs ?? 0),
		ok: exitCode === 0,
		error: stderr,
	};
}

export function batchExecResultFromApi(payload: ApiObject): BatchExecResult {
	const exitCode = Number(payload.exitCode);
	return {
		id: String(payload.id),
		stdout: typeof payload.stdout === "string" ? payload.stdout : "",
		stderr: typeof payload.stderr === "string" ? payload.stderr : "",
		exitCode,
		durationMs: Number(payload.durationMs ?? 0),
		error: typeof payload.error === "string" ? payload.error : undefined,
		ok: exitCode === 0,
	};
}

export function streamEventFromSse(eventName: string, payload: ApiObject): StreamEvent {
	if (eventName === "exit") {
		return {
			type: "exit",
			t: typeof payload.t === "number" ? payload.t : undefined,
			exitCode: typeof payload.exitCode === "number" ? payload.exitCode : undefined,
			durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
			error: typeof payload.error === "string" ? payload.error : undefined,
		};
	}
	if (eventName === "stdout" || eventName === "stderr") {
		return {
			type: eventName,
			data: typeof payload.data === "string" ? payload.data : "",
			t: typeof payload.t === "number" ? payload.t : undefined,
		};
	}
	throw Object.assign(new Error(`unknown SSE event: ${eventName}`), { code: "EUNKNOWN_SSE_EVENT" });
}
