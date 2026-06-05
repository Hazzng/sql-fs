import { ValidationError } from "./errors.js";
import { type Transport, encodePath, iterSseEvents } from "./http.js";
import { defaultMaxFileSize, isRecord, readJsonObject } from "./internal.js";
import {
	type BatchExecResult,
	type ExecResult,
	type FileStat,
	ReadResult,
	type SandboxRecord,
	type StreamEvent,
	type TreeEntry,
	batchExecResultFromApi,
	execResultFromApi,
	fileStatFromApi,
	streamEventFromSse,
	treeEntryFromApi,
} from "./models.js";

export type FileContent = string | Uint8Array | ArrayBuffer;

interface BaseExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	debug?: boolean;
	readOnly?: boolean;
}

export interface ExecOptions extends BaseExecOptions {
	retryOn5xx?: boolean;
}

export interface ExecBatchScript {
	id: string;
	script: string;
}

export interface ExecBatchOptions {
	timeoutMs?: number;
	perScriptTimeoutMs?: number;
	readOnly?: boolean;
	retryOn5xx?: boolean;
}

export type ExecStreamOptions = BaseExecOptions;

export interface TreeOptions {
	prefix?: string;
	depth?: number;
}

export interface DeleteOptions {
	recursive?: boolean;
}

export interface MkdirOptions {
	recursive?: boolean;
}

export class FilesAPI {
	private readonly transport: Transport;
	private readonly sandboxId: string;
	private readonly maxFileSize: number;

	constructor(transport: Transport, sandboxId: string, maxFileSize = defaultMaxFileSize) {
		this.transport = transport;
		this.sandboxId = sandboxId;
		this.maxFileSize = maxFileSize;
	}

	async read(path: string): Promise<ReadResult> {
		const response = await this.transport.request("GET", `/sandboxes/${this.sandboxId}/files/${encodePath(path)}`);
		const stat = parseStatHeader(response.headers.get("X-FS-Stat"));
		return new ReadResult(new Uint8Array(await response.arrayBuffer()), stat);
	}

	async readText(path: string, encoding = "utf-8"): Promise<string> {
		return (await this.read(path)).text(encoding);
	}

	async write(path: string, content: FileContent): Promise<void> {
		const bytes = toBytes(content);
		enforceMaxFileSize({ [path]: bytes }, this.maxFileSize);
		await this.transport.request("PUT", `/sandboxes/${this.sandboxId}/files/${encodePath(path)}`, {
			content: bytes,
			headers: { "Content-Type": "application/octet-stream" },
		});
	}

	async writeFiles(files: Record<string, string>): Promise<void> {
		enforceMaxFileSize(files, this.maxFileSize);
		await this.transport.request("POST", `/sandboxes/${this.sandboxId}/writeFiles`, {
			jsonBody: { files: { ...files } },
		});
	}

	async delete(path: string, options: DeleteOptions = {}): Promise<void> {
		await this.transport.request("DELETE", `/sandboxes/${this.sandboxId}/files/${encodePath(path)}`, {
			params: options.recursive ? { recursive: "true" } : undefined,
		});
	}

	async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
		await this.transport.request("POST", `/sandboxes/${this.sandboxId}/mkdir`, {
			jsonBody: { path, recursive: options.recursive ?? false },
		});
	}

	async tree(options: TreeOptions = {}): Promise<TreeEntry[]> {
		const response = await this.transport.request("GET", `/sandboxes/${this.sandboxId}/tree`, {
			params: { prefix: options.prefix, depth: options.depth },
		});
		const payload = (await response.json()) as unknown;
		if (!Array.isArray(payload)) {
			return [];
		}
		return payload.filter(isRecord).map(treeEntryFromApi);
	}
}

export class Sandbox {
	readonly fs: FilesAPI;
	private readonly transport: Transport;
	private readonly sandboxId: string;
	private readonly sandboxRecord?: SandboxRecord;
	private readonly maxFileSize: number;

	constructor(transport: Transport, sandboxId: string, options: { record?: SandboxRecord; maxFileSize?: number } = {}) {
		this.transport = transport;
		this.sandboxId = sandboxId;
		this.sandboxRecord = options.record;
		this.maxFileSize = options.maxFileSize ?? defaultMaxFileSize;
		this.fs = new FilesAPI(transport, sandboxId, this.maxFileSize);
	}

	get id(): string {
		return this.sandboxId;
	}

	get record(): SandboxRecord | undefined {
		return this.sandboxRecord;
	}

	async exec(script: string, options: ExecOptions = {}): Promise<ExecResult> {
		const timeoutMs = options.timeoutMs ?? 30_000;
		const body = execRequestBody(script, options, timeoutMs);
		if (options.retryOn5xx) {
			body.retryOn5xx = true;
		}
		const response = await this.transport.request("POST", `/sandboxes/${this.sandboxId}/exec-sync`, {
			jsonBody: body,
			timeout: clientTimeout(timeoutMs),
			idempotent: Boolean(options.readOnly || options.retryOn5xx),
			readOnly: Boolean(options.readOnly),
		});
		return execResultFromApi(await readJsonObject(response));
	}

	async execBatch(scripts: ExecBatchScript[], options: ExecBatchOptions = {}): Promise<BatchExecResult[]> {
		const timeoutMs = options.timeoutMs ?? 30_000;
		const body: Record<string, unknown> = {
			scripts: scripts.map((script) => ({ ...script })),
			timeoutMs,
		};
		if (options.perScriptTimeoutMs !== undefined) {
			body.perScriptTimeoutMs = options.perScriptTimeoutMs;
		}
		if (options.readOnly) {
			body.readOnly = true;
		}
		if (options.retryOn5xx) {
			body.retryOn5xx = true;
		}
		const response = await this.transport.request("POST", `/sandboxes/${this.sandboxId}/exec-sync-batch`, {
			jsonBody: body,
			timeout: clientTimeout(timeoutMs),
			idempotent: Boolean(options.readOnly || options.retryOn5xx),
			readOnly: Boolean(options.readOnly),
		});
		const payload = await readJsonObject(response);
		return Array.isArray(payload.results) ? payload.results.filter(isRecord).map(batchExecResultFromApi) : [];
	}

	async *execStream(script: string, options: ExecStreamOptions = {}): AsyncGenerator<StreamEvent> {
		const timeoutMs = options.timeoutMs ?? 30_000;
		const body = execRequestBody(script, options, timeoutMs);
		const response = await this.transport.stream("POST", `/sandboxes/${this.sandboxId}/exec`, {
			jsonBody: body,
			headers: { Accept: "text/event-stream" },
			timeout: clientTimeout(timeoutMs),
		});
		try {
			for await (const [eventName, payload] of iterSseEvents(response)) {
				if (eventName === "error") {
					const errorBody = isRecord(payload) ? payload : {};
					throw new ValidationError(typeof errorBody.error === "string" ? errorBody.error : "unknown error", {
						code: typeof errorBody.code === "string" ? errorBody.code : undefined,
						status: 422,
					});
				}
				if (eventName !== "stdout" && eventName !== "stderr" && eventName !== "exit") {
					continue;
				}
				if (!isRecord(payload)) {
					continue;
				}
				yield streamEventFromSse(eventName, payload);
				if (eventName === "exit") {
					return;
				}
			}
		} finally {
			await response.body?.cancel();
		}
	}

	async ingestFiles(
		files: Record<string, FileContent>,
		options: { basePath?: string } = {},
	): Promise<Record<string, unknown>> {
		enforceMaxFileSize(files, this.maxFileSize);
		const encoded: Record<string, string> = Object.create(null) as Record<string, string>;
		for (const [path, content] of Object.entries(files)) {
			encoded[path] = toBase64(content);
		}
		const response = await this.transport.request("POST", `/sandboxes/${this.sandboxId}/ingest-files`, {
			jsonBody: { basePath: options.basePath ?? "/home/user/project", files: encoded },
		});
		return readJsonObject(response);
	}

	async delete(): Promise<void> {
		await this.transport.request("DELETE", `/sandboxes/${this.sandboxId}`);
	}
}

function execRequestBody(script: string, options: BaseExecOptions, timeoutMs: number): Record<string, unknown> {
	const body: Record<string, unknown> = { script, timeoutMs };
	if (options.cwd !== undefined) {
		body.cwd = options.cwd;
	}
	if (options.env !== undefined) {
		body.env = { ...options.env };
	}
	if (options.debug) {
		body.debug = true;
	}
	if (options.readOnly) {
		body.readOnly = true;
	}
	return body;
}

function clientTimeout(timeoutMs: number): number {
	return Math.max(timeoutMs + 5000, 35_000);
}

function parseStatHeader(raw: string | null): FileStat | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const value = JSON.parse(raw) as unknown;
		return isRecord(value) ? fileStatFromApi(value) : undefined;
	} catch (_error) {
		return undefined;
	}
}

function contentSize(content: FileContent): number {
	return toBytes(content).byteLength;
}

function enforceMaxFileSize(files: Record<string, FileContent>, maxFileSize: number): void {
	if (maxFileSize <= 0) {
		return;
	}
	const tooBig = Object.entries(files)
		.map(([path, content]) => [path, contentSize(content)] as const)
		.filter(([, size]) => size > maxFileSize);
	if (tooBig.length === 0) {
		return;
	}
	const details = tooBig.map(([path, size]) => `${path} (${size} bytes > ${maxFileSize} limit)`);
	throw new ValidationError(`file exceeds maxFileSize: ${details.join("; ")}`, {
		code: "EFILE_TOO_LARGE",
		details,
	});
}

function toBytes(content: FileContent): Uint8Array<ArrayBuffer> {
	if (typeof content === "string") {
		return new TextEncoder().encode(content);
	}
	if (content instanceof Uint8Array) {
		return new Uint8Array(content);
	}
	return new Uint8Array(content);
}

function toBase64(content: FileContent): string {
	return Buffer.from(toBytes(content)).toString("base64");
}
