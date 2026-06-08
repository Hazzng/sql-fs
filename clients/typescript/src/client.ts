import { Transport, type TransportOptions } from "./http.js";
import { defaultMaxFileSize, isRecord, readJsonObject } from "./internal.js";
import {
	type PythonRuntime,
	type SandboxInfo,
	type SandboxRecord,
	sandboxInfoFromApi,
	sandboxRecordFromApi,
} from "./models.js";
import { Sandbox } from "./sandbox.js";

export interface ClientOptions extends TransportOptions {
	maxFileSize?: number;
}

export interface CreateSandboxOptions {
	name?: string;
	env?: Record<string, string>;
	files?: Record<string, string>;
	python_runtime?: PythonRuntime;
	javascript?: boolean;
	network?: boolean;
}

export class Client {
	readonly sandboxes: SandboxesResource;
	private readonly transport: Transport;

	constructor(options: ClientOptions) {
		this.transport = new Transport(options);
		this.sandboxes = new SandboxesResource(this.transport, {
			maxFileSize: options.maxFileSize ?? defaultMaxFileSize,
		});
	}

	get token(): string | undefined {
		return this.transport.token;
	}

	async getToken(): Promise<string> {
		return this.transport.getToken();
	}

	close(): void {
		this.transport.close();
	}
}

export class SandboxesResource {
	private readonly transport: Transport;
	private readonly maxFileSize: number;

	constructor(transport: Transport, options: { maxFileSize?: number } = {}) {
		this.transport = transport;
		this.maxFileSize = options.maxFileSize ?? defaultMaxFileSize;
	}

	async list(): Promise<SandboxRecord[]> {
		const response = await this.transport.request("GET", "/sandboxes");
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload) || !Array.isArray(payload.sandboxes)) {
			return [];
		}
		return payload.sandboxes.filter(isRecord).map(sandboxRecordFromApi);
	}

	async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
		const body: Record<string, unknown> = {};
		if (options.name !== undefined) {
			body.name = options.name;
		}
		if (options.env !== undefined) {
			body.env = { ...options.env };
		}
		if (options.files !== undefined) {
			body.files = { ...options.files };
		}
		if (options.python_runtime !== undefined) {
			body.python_runtime = options.python_runtime;
		}
		if (options.javascript !== undefined) {
			body.javascript = options.javascript;
		}
		if (options.network !== undefined) {
			body.network = options.network;
		}
		const response = await this.transport.request("POST", "/sandboxes", {
			jsonBody: body,
			idempotent: false,
		});
		const record = sandboxRecordFromApi(await readJsonObject(response));
		return new Sandbox(this.transport, record.id, { record, maxFileSize: this.maxFileSize });
	}

	async get(sandboxId: string): Promise<SandboxInfo> {
		const response = await this.transport.request("GET", `/sandboxes/${sandboxId}`);
		return sandboxInfoFromApi(await readJsonObject(response));
	}

	attach(sandboxId: string): Sandbox {
		return new Sandbox(this.transport, sandboxId, { maxFileSize: this.maxFileSize });
	}

	async delete(sandboxId: string): Promise<void> {
		await this.transport.request("DELETE", `/sandboxes/${sandboxId}`);
	}
}
