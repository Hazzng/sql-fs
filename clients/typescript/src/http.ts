import {
	AuthError,
	ConflictError,
	ExecTimeoutError,
	NotFoundError,
	RateLimitError,
	ServerError,
	SQLFSError,
	TransportError,
	ValidationError,
} from "./errors.js";
import { readJsonObject } from "./internal.js";
import { version } from "./version.js";

export type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface TransportOptions {
	baseUrl: string;
	token?: string;
	authSecret?: string;
	adminSecret?: string;
	sub?: string;
	tenant?: string;
	expiresIn?: string;
	timeout?: number;
	maxRetries?: number;
	userAgent?: string;
	fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
	jsonBody?: JsonValue;
	content?: BodyInit;
	params?: Record<string, unknown>;
	headers?: Record<string, string>;
	timeout?: number;
	idempotent?: boolean;
	readOnly?: boolean;
	retryTransportErrors?: boolean;
	requireExplicitRetryable?: boolean;
}

const defaultMaxRetries = 3;
const defaultTimeoutMs = 30_000;
const retryStatus = new Set([429, 500, 502, 503, 504]);
const UNKNOWN_OUTCOME_CODES: ReadonlySet<string> = new Set(["EEXEC_OUTCOME_UNKNOWN", "EDRIVERFAULT"]);
const COMMITTED_WRITE_CODES: ReadonlySet<string> = new Set(["ECOHERENCE", "ELOCKLOST_APPLIED"]);
const CONNECTION_EXCEPTION_SQLSTATE = /^08[0-9A-Z]{3}$/;
const STREAM_ERROR_STATUS_BY_CODE: ReadonlyMap<string, number> = new Map([
	["ENOENT", 404],
	["EEXIST", 409],
	["ENOTEMPTY", 409],
	["ESTALE", 409],
	["EPERM", 403],
	["FORBIDDEN", 403],
	["EISDIR", 400],
	["ENOTDIR", 400],
	["ELOOP", 400],
	["EINVAL", 400],
	["EREADONLY", 500],
	["ESESSIONCLOSING", 503],
	["ESHUTTINGDOWN", 503],
	["ELOCKTIMEOUT", 503],
	["ELOCKLOST", 503],
	["ELOCKLOST_APPLIED", 503],
	["ECOHERENCE", 503],
	["EDRIVERFAULT", 503],
	["ECOHERENCE_UNAPPLIED", 503],
	["EWORKER_BUSY", 503],
	["EWORKER_UNAVAILABLE", 503],
	["EEXEC_OUTCOME_UNKNOWN", 503],
	["ERUNTIME_BUSY", 503],
	["EUNAVAILABLE", 503],
	["ESCRIPTBUFFER", 413],
	["EEXEC_INPUT_LIMIT", 413],
	["EFBIG", 413],
	["EREADONLY_VIOLATION", 422],
	["INTERNAL_ERROR", 500],
]);

export function encodePath(path: string): string {
	return path
		.replace(/^\/+/, "")
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

export class Transport {
	private readonly baseUrl: string;
	private currentToken?: string;
	private tokenPromise?: Promise<string>;
	private readonly authSecret?: string;
	private readonly adminSecret?: string;
	private readonly adminBearerToken?: string;
	private readonly sub?: string;
	private readonly tenant?: string;
	private readonly expiresIn: string;
	private readonly timeout: number;
	private readonly maxRetries: number;
	private readonly userAgent: string;
	private readonly fetchImpl: typeof globalThis.fetch;

	constructor(options: TransportOptions) {
		if (!(options.token || options.authSecret || options.adminSecret)) {
			throw new Error("Provide one of: token, authSecret, or adminSecret");
		}
		if ((options.authSecret || options.adminSecret) && !options.sub) {
			throw new Error("sub is required when bootstrapping a token from a secret");
		}
		if (options.adminSecret && !options.token) {
			throw new Error("token is required with adminSecret because /v1/auth/admin requires Bearer authentication");
		}
		if (options.authSecret && options.adminSecret) {
			throw new Error("authSecret and adminSecret are mutually exclusive");
		}

		this.baseUrl = trimTrailingSlashes(options.baseUrl);
		this.currentToken = options.adminSecret ? undefined : options.token;
		this.authSecret = options.authSecret;
		this.adminSecret = options.adminSecret;
		this.adminBearerToken = options.adminSecret ? options.token : undefined;
		this.sub = options.sub;
		this.tenant = options.tenant;
		this.expiresIn = options.expiresIn ?? "30d";
		this.timeout = options.timeout ?? defaultTimeoutMs;
		this.maxRetries = options.maxRetries ?? defaultMaxRetries;
		this.userAgent = options.userAgent ?? `sql-fs-sdk/${version}`;
		this.fetchImpl = options.fetch ?? globalThis.fetch;

		if (typeof this.fetchImpl !== "function") {
			throw new Error("No fetch implementation available; pass fetch in Client options");
		}
	}

	get token(): string | undefined {
		return this.currentToken;
	}

	async getToken(): Promise<string> {
		if (this.currentToken !== undefined) {
			return this.currentToken;
		}
		if (this.tokenPromise === undefined) {
			this.tokenPromise = this.bootstrapToken()
				.then((token) => {
					this.currentToken = token;
					return token;
				})
				.finally(() => {
					this.tokenPromise = undefined;
				});
		}
		return this.tokenPromise;
	}

	close(): void {}

	async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
		const url = new URL(`${this.baseUrl}/v1${path}`);
		appendParams(url, options.params);
		const headers = await this.authHeaders();
		if (options.headers) {
			for (const [key, value] of Object.entries(options.headers)) {
				headers.set(key, value);
			}
		}

		let body: BodyInit | undefined;
		if (options.content !== undefined) {
			body = options.content;
		} else if (options.jsonBody !== undefined) {
			body = JSON.stringify(options.jsonBody);
			headers.set("Content-Type", "application/json");
		}

		const timeout = options.timeout ?? this.timeout;
		const idempotent = options.idempotent ?? true;
		const readOnly = options.readOnly ?? false;
		const retryTransportErrors = options.retryTransportErrors ?? true;
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			let response: Response;
			try {
				response = await this.fetchWithTimeout(url, { method, headers, body }, timeout);
			} catch (error) {
				if (!retryTransportErrors || attempt >= this.maxRetries || (!idempotent && !readOnly)) {
					throw new TransportError(`network error after ${attempt + 1} attempts: ${formatError(error)}`);
				}
				await sleepBackoff(attempt);
				continue;
			}

			if (
				retryStatus.has(response.status) &&
				attempt < this.maxRetries &&
				(await shouldRetryResponse(response, {
					idempotent,
					readOnly,
					method,
					requireExplicitRetryable: options.requireExplicitRetryable ?? false,
				}))
			) {
				const retryAfter = parseRetryAfter(response);
				if (retryAfter !== undefined) {
					await sleep(Math.min(retryAfter * 1000, 30_000));
				} else {
					await sleepBackoff(attempt);
				}
				continue;
			}

			if (response.status >= 400) {
				await raiseForStatus(response);
			}
			return response;
		}

		throw new TransportError("unexpected retry exhaustion");
	}

	async stream(method: string, path: string, options: Omit<RequestOptions, "content"> = {}): Promise<Response> {
		const url = new URL(`${this.baseUrl}/v1${path}`);
		appendParams(url, options.params);
		const headers = await this.authHeaders();
		if (options.headers) {
			for (const [key, value] of Object.entries(options.headers)) {
				headers.set(key, value);
			}
		}
		let body: BodyInit | undefined;
		if (options.jsonBody !== undefined) {
			body = JSON.stringify(options.jsonBody);
			headers.set("Content-Type", "application/json");
		}
		const response = await this.fetchWithTimeout(url, { method, headers, body }, options.timeout ?? this.timeout);
		if (response.status >= 400) {
			await raiseForStatus(response);
		}
		return response;
	}

	private async bootstrapToken(): Promise<string> {
		const body: Record<string, unknown> = { sub: this.sub, expiresIn: this.expiresIn };
		let url: string;
		const headers = new Headers({ "User-Agent": this.userAgent, "Content-Type": "application/json" });
		if (this.authSecret !== undefined) {
			if (this.tenant) {
				body.tenant = this.tenant;
			}
			url = `${this.baseUrl}/v1/auth/bootstrap`;
			headers.set("X-Auth-Secret", this.authSecret);
		} else {
			url = `${this.baseUrl}/v1/auth/admin`;
			headers.set("X-Admin-Secret", this.adminSecret!);
			headers.set("Authorization", `Bearer ${this.adminBearerToken!}`);
		}

		const response = await this.fetchWithTimeout(
			url,
			{ method: "POST", headers, body: JSON.stringify(body) },
			this.timeout,
		);
		if (response.status !== 201) {
			await raiseForStatus(response);
		}
		const payload = await readJsonObject(response);
		if (typeof payload.token !== "string") {
			throw new AuthError("bootstrap response missing token", { status: response.status, details: payload });
		}
		return payload.token;
	}

	private async authHeaders(): Promise<Headers> {
		return new Headers({
			Authorization: `Bearer ${await this.getToken()}`,
			"User-Agent": this.userAgent,
		});
	}

	private async fetchWithTimeout(input: string | URL, init: RequestInit, timeout: number): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		try {
			return await this.fetchImpl(input, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}
}

async function raiseForStatus(response: Response): Promise<never> {
	return raiseApiError(response.status, await readJsonObject(response.clone()), parseRetryAfter(response));
}

export function statusForStreamError(code: string): number {
	return STREAM_ERROR_STATUS_BY_CODE.get(code) ?? 422;
}

export function raiseApiError(status: number, body: Record<string, unknown>, retryAfter?: number): never {
	const message = typeof body.error === "string" ? body.error : `HTTP ${status}`;
	const options = {
		code: typeof body.code === "string" ? body.code : undefined,
		status,
		details: body.details,
		retryable: typeof body.retryable === "boolean" ? body.retryable : undefined,
	};
	if (status === 401 || status === 403) {
		throw new AuthError(message, options);
	}
	if (status === 404) {
		throw new NotFoundError(message, options);
	}
	if (status === 408) {
		throw new ExecTimeoutError(message, {
			...options,
			durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
		});
	}
	if (status === 409) {
		throw new ConflictError(message, options);
	}
	if (status === 400 || status === 413 || status === 422) {
		throw new ValidationError(message, options);
	}
	if (status === 429) {
		throw new RateLimitError(message, { ...options, retryAfter });
	}
	if (status >= 500 && status < 600) {
		throw new ServerError(message, options);
	}
	throw new SQLFSError(message, options);
}

async function shouldRetryResponse(
	response: Response,
	options: { idempotent: boolean; readOnly: boolean; method: string; requireExplicitRetryable: boolean },
): Promise<boolean> {
	const body = await readJsonObject(response.clone());
	const code = typeof body.code === "string" ? body.code : "";
	if (code === "EEXEC_OUTCOME_UNKNOWN") return false;
	if (COMMITTED_WRITE_CODES.has(code)) return false;
	if (options.requireExplicitRetryable && body.retryable !== true) return false;
	const safeRead = options.idempotent && (options.method === "GET" || options.method === "HEAD");
	if (
		safeRead &&
		response.status === 503 &&
		(code === "EDRIVERFAULT" || code === "EUNAVAILABLE" || CONNECTION_EXCEPTION_SQLSTATE.test(code))
	)
		return true;
	if (UNKNOWN_OUTCOME_CODES.has(code) || CONNECTION_EXCEPTION_SQLSTATE.test(code)) return false;
	return body.retryable !== false && (options.idempotent || options.readOnly);
}

function parseRetryAfter(response: Response): number | undefined {
	const raw = response.headers.get("Retry-After");
	if (raw === null) {
		return undefined;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function appendParams(url: URL, params?: Record<string, unknown>): void {
	if (!params) {
		return;
	}
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null) {
			url.searchParams.set(key, String(value));
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepBackoff(attempt: number): Promise<void> {
	const base = 250;
	await sleep(Math.min(Math.random() * base * 2 ** attempt, 8000));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function* iterLines(response: Response): AsyncGenerator<string> {
	if (!response.body) {
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex = buffer.search(/\r?\n/);
			while (newlineIndex >= 0) {
				const rawLine = buffer.slice(0, newlineIndex);
				const newlineLength = buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n" ? 2 : 1;
				buffer = buffer.slice(newlineIndex + newlineLength);
				yield rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				newlineIndex = buffer.search(/\r?\n/);
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) {
			yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		}
	} finally {
		reader.releaseLock();
	}
}

function parseSsePayload(dataLines: string[]): unknown {
	const raw = dataLines.join("\n");
	try {
		return JSON.parse(raw);
	} catch {
		return { raw };
	}
}

export async function* iterSseEvents(response: Response): AsyncGenerator<[string, unknown]> {
	let eventName = "message";
	let dataLines: string[] = [];

	for await (const line of iterLines(response)) {
		if (line === "") {
			if (dataLines.length > 0) {
				yield [eventName, parseSsePayload(dataLines)];
				eventName = "message";
				dataLines = [];
			}
		} else if (line.startsWith(":")) {
			// Ignore SSE comments and heartbeat lines.
		} else if (line.startsWith("event:")) {
			eventName = line.slice("event:".length).trim();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).replace(/^ /, ""));
		}
	}

	if (dataLines.length > 0) {
		yield [eventName, parseSsePayload(dataLines)];
	}
}

// A scan from the end, not `/\/+$/`, which backtracks quadratically on long runs of interior slashes (CodeQL js/polynomial-redos).
function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
	return value.slice(0, end);
}
