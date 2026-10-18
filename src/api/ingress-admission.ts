import { AsyncLocalStorage } from "node:async_hooks";
import { ServerResponse } from "node:http";
import { Http2ServerResponse } from "node:http2";
import type { Context, MiddlewareHandler, Next } from "hono";
import { assertTimerMs } from "./lib/env.js";
import { FairAdmission } from "./worker-owner/admission.js";
import { WorkerBusyError } from "./worker-owner/protocol.js";

interface IngressRetention {
	readonly hold: () => () => void;
}

type IngressFailure =
	| { readonly kind: "busy" | "too_large" | "aborted" | "shutdown" }
	| { readonly kind: "input_error"; readonly error: unknown };

type InputDemand = { readonly kind: "queued" | "idle" } | { readonly kind: "pull"; readonly resolve: () => void };

const ingressRetention = new AsyncLocalStorage<IngressRetention>();

export function retainIngressWork<Args extends unknown[], Result>(
	work: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
	return async (...args) => {
		const release = ingressRetention.getStore()?.hold();
		try {
			return await work(...args);
		} finally {
			release?.();
		}
	};
}

export interface IngressOptions {
	readonly maxRequests: number;
	readonly maxTenantRequests: number;
	readonly maxQueuedRequests?: number;
	readonly maxTenantQueuedRequests?: number;
	readonly maxMcpListeners?: number;
	readonly maxTenantMcpListeners?: number;
	readonly maxBytes: number;
	readonly maxTenantBytes: number;
	readonly maxBodyBytes: number;
	readonly waitMs: number;
}

export function loadIngressOptions(env: NodeJS.ProcessEnv = process.env): IngressOptions {
	const read = (name: string, fallback: number, minimum = 1): number => {
		const raw = env[name];
		const value = raw === undefined || raw === "" ? fallback : Number(raw);
		if (!Number.isSafeInteger(value) || value < minimum) {
			throw new Error(`${name} must be a ${minimum === 0 ? "nonnegative" : "positive"} safe integer`);
		}
		return value;
	};
	const maxRequests = read("SQL_FS_MAX_INGRESS_REQUESTS", 8);
	const maxTenantRequests = read("SQL_FS_MAX_INGRESS_TENANT_REQUESTS", Math.max(1, Math.floor(maxRequests / 2)));
	if (maxTenantRequests > Math.max(1, maxRequests - 1)) {
		throw new Error("SQL_FS_MAX_INGRESS_TENANT_REQUESTS must leave capacity for another tenant");
	}
	const maxQueuedRequests = read("SQL_FS_MAX_INGRESS_QUEUED_REQUESTS", maxRequests, 0);
	const tenantQueueShare = maxQueuedRequests > 1 ? maxQueuedRequests - 1 : maxQueuedRequests;
	const maxTenantQueuedRequests = read(
		"SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS",
		Math.min(maxTenantRequests, tenantQueueShare),
		0,
	);
	if (maxTenantQueuedRequests > tenantQueueShare) {
		throw new Error("SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS must leave capacity for another tenant");
	}
	const maxMcpListeners = read("SQL_FS_MAX_INGRESS_MCP_LISTENERS", maxRequests);
	const maxTenantMcpListeners = read(
		"SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS",
		Math.max(1, Math.floor(maxMcpListeners / 2)),
	);
	if (maxTenantMcpListeners > Math.max(1, maxMcpListeners - 1)) {
		throw new Error("SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS must leave capacity for another tenant");
	}
	const maxBytes = read("SQL_FS_MAX_INGRESS_BYTES", 128 * 1024 * 1024);
	const maxTenantBytes = read("SQL_FS_MAX_INGRESS_TENANT_BYTES", Math.max(1, maxBytes - Math.ceil(maxBytes / 4)));
	if (maxTenantBytes > Math.max(1, maxBytes - 1)) {
		throw new Error("SQL_FS_MAX_INGRESS_TENANT_BYTES must leave capacity for another tenant");
	}
	return {
		maxRequests,
		maxTenantRequests,
		maxQueuedRequests,
		maxTenantQueuedRequests,
		maxMcpListeners,
		maxTenantMcpListeners,
		maxBytes,
		maxTenantBytes,
		maxBodyBytes: read("MAX_REQUEST_BODY_BYTES", 256 * 1024 * 1024),
		waitMs: assertTimerMs("SQL_FS_MAX_INGRESS_WAIT_MS", read("SQL_FS_MAX_INGRESS_WAIT_MS", 250)),
	};
}

export class IngressAdmission {
	private readonly admission: FairAdmission;
	private readonly mcpListenerAdmission: FairAdmission;
	private closed = false;
	private readonly bootstrapTenant = Symbol("bootstrap");
	private retainedRawBytes = 0;
	private readonly tenantBytes = new Map<string | symbol, number>();
	private refused = 0;
	private payloadTooLarge = 0;
	private aborted = 0;

	constructor(private readonly options: IngressOptions) {
		const maxQueued = options.maxQueuedRequests ?? options.maxRequests;
		this.admission = new FairAdmission({
			capacity: options.maxRequests,
			maxActivePerTenant: options.maxTenantRequests,
			maxQueued,
			maxQueuedPerTenant:
				options.maxTenantQueuedRequests ??
				Math.min(options.maxTenantRequests, maxQueued > 1 ? maxQueued - 1 : maxQueued),
			maxQueuedBytes: 0,
			maxQueuedBytesPerTenant: 0,
			waitMs: options.waitMs,
		});
		this.mcpListenerAdmission = new FairAdmission({
			capacity: options.maxMcpListeners ?? options.maxRequests,
			maxActivePerTenant: options.maxTenantMcpListeners ?? options.maxTenantRequests,
			maxQueued: options.maxMcpListeners ?? options.maxRequests,
			maxQueuedPerTenant: options.maxTenantMcpListeners ?? options.maxTenantRequests,
			maxQueuedBytes: 0,
			maxQueuedBytesPerTenant: 0,
			waitMs: options.waitMs,
		});
	}

	close(): void {
		this.closed = true;
		this.admission.close();
		this.mcpListenerAdmission.close();
	}

	get metrics() {
		const admission = this.admission.metrics;
		const mcpListeners = this.mcpListenerAdmission.metrics;
		return {
			requestCapacity: this.options.maxRequests,
			queueCapacity: this.options.maxQueuedRequests ?? this.options.maxRequests,
			rawByteCapacity: this.options.maxBytes,
			queueWaitLimitMs: this.options.waitMs,
			activeRequests: admission.active,
			queuedRequests: admission.queued,
			offered: admission.offered,
			admitted: admission.admitted,
			completed: admission.completed,
			cancelled: admission.cancelled,
			totalWaitMs: admission.totalWaitMs,
			waitBuckets: admission.waitBuckets,
			queueTimeouts: admission.timedOut,
			activeMcpListeners: mcpListeners.active,
			queuedMcpListeners: mcpListeners.queued,
			mcpListenerQueueTimeouts: mcpListeners.timedOut,
			mcpListenerRefused: mcpListeners.refused,
			retainedRawBytes: this.retainedRawBytes,
			refused: this.refused + admission.refused,
			payloadTooLarge: this.payloadTooLarge,
			aborted: this.aborted,
		};
	}

	readonly middleware: MiddlewareHandler = async (c, next) => {
		return this.admitAuthenticatedTenant(c, next, this.admission);
	};

	readonly mcpMiddleware: MiddlewareHandler = (c, next) =>
		this.admitAuthenticatedTenant(c, next, c.req.method === "GET" ? this.mcpListenerAdmission : this.admission);

	private async admitAuthenticatedTenant(c: Context, next: Next, admission: FairAdmission) {
		const tenant: unknown = c.get("tenant");
		if (typeof tenant !== "string" || tenant.length === 0) {
			return c.json({ error: "unauthorized", code: "AUTH_REQUIRED" }, 401);
		}
		return this.admit(c, next, tenant, admission);
	}

	readonly bootstrapMiddleware: MiddlewareHandler = (c, next) =>
		this.admit(c, next, this.bootstrapTenant, this.admission);

	private async admit(c: Context, next: Next, tenant: string | symbol, admission: FairAdmission) {
		const body = c.req.raw.body;
		const busy = (code: "EWORKER_BUSY" | "ESHUTTINGDOWN" = "EWORKER_BUSY") => {
			c.header("Retry-After", "1");
			return c.json(
				{
					code,
					error: code === "ESHUTTINGDOWN" ? "Request capacity is shutting down" : "Request capacity is busy",
					retryable: true,
				},
				503,
			);
		};
		const bodyLimit = Math.min(this.options.maxBodyBytes, this.options.maxTenantBytes);
		const tooLarge = () =>
			c.json(
				{
					code: "PAYLOAD_TOO_LARGE",
					retryable: false,
					error: "payload_too_large",
					details: [`Request body exceeds limit (${bodyLimit} bytes)`],
				},
				413,
			);
		const declared = Number(c.req.header("content-length"));
		if (Number.isFinite(declared) && declared > bodyLimit) {
			this.payloadTooLarge++;
			void body?.cancel().catch(() => {});
			return tooLarge();
		}

		const signal = c.req.raw.signal;
		const cancellation = new AbortController();
		const key = typeof tenant === "string" ? `tenant:${tenant}` : "bootstrap";
		let releaseAdmission: (() => void) | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let retained = 0;
		let failure: IngressFailure | undefined;
		let ended = false;
		let demand: InputDemand = { kind: "idle" };
		let wakeInput: (() => void) | undefined;
		let abortOutput: (() => void) | undefined;
		const hasDemand = () => demand.kind !== "idle";
		const waitForInput = () =>
			new Promise<void>((resolve) => {
				wakeInput = resolve;
			});
		const finishPull = () => {
			if (demand.kind !== "pull") return;
			const { resolve } = demand;
			demand = { kind: "idle" };
			resolve();
		};
		const cancel = () => {
			ended = true;
			finishPull();
			wakeInput?.();
			wakeInput = undefined;
			void (reader === undefined ? body?.cancel() : reader.cancel())?.catch(() => {});
		};
		const fail = (cause: IngressFailure) => {
			if (failure !== undefined) return;
			failure = cause;
			if (cause.kind === "aborted") this.aborted++;
			if (cause.kind === "too_large") this.payloadTooLarge++;
			ended = true;
			inputController?.error(
				cause.kind === "input_error" ? cause.error : new DOMException("Request input stopped", "AbortError"),
			);
			cancellation.abort();
			cancel();
			if (cause.kind === "aborted") abortOutput?.();
		};
		const failureResponse = () => {
			switch (failure?.kind) {
				case "busy":
					return busy();
				case "shutdown":
					return busy("ESHUTTINGDOWN");
				case "too_large":
					return tooLarge();
				case "aborted":
					return new Response(null, { status: 499 });
				case "input_error":
					throw failure.error;
				default:
					return undefined;
			}
		};
		const onAbort = () => fail({ kind: "aborted" });
		let references = 1;
		const release = () => {
			if (--references !== 0) return;
			signal.removeEventListener("abort", onAbort);
			inputController?.error(new DOMException("Request already completed", "AbortError"));
			cancel();
			this.retainedRawBytes -= retained;
			const remainingBytes = (this.tenantBytes.get(tenant) ?? 0) - retained;
			if (remainingBytes === 0) this.tenantBytes.delete(tenant);
			else this.tenantBytes.set(tenant, remainingBytes);
			releaseAdmission?.();
		};
		const hold = () => {
			if (references === 0) throw new DOMException("Request already completed", "AbortError");
			references++;
			let held = true;
			return () => {
				if (!held) return;
				held = false;
				release();
			};
		};
		const startInput = () => {
			if (body === null || reader !== undefined || ended) return;
			const bodyReader = body.getReader();
			reader = bodyReader;
			const counted = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						inputController = controller;
					},
					pull() {
						if (ended) return;
						return new Promise<void>((resolve) => {
							demand = { kind: "pull", resolve };
							wakeInput?.();
							wakeInput = undefined;
						});
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			c.req.raw = new Request(c.req.raw, {
				body: counted,
				signal: cancellation.signal,
				duplex: "half",
			} as RequestInit);
			const pump = async () => {
				try {
					while (!ended) {
						while (!ended && !hasDemand()) await waitForInput();
						if (ended) return;
						const { done, value } = await bodyReader.read();
						while (!ended && !hasDemand()) await waitForInput();
						if (ended) return;
						if (done) {
							ended = true;
							inputController?.close();
							finishPull();
							return;
						}
						if (value.byteLength > bodyLimit - retained) {
							fail({ kind: "too_large" });
							return;
						}
						if (
							value.byteLength > this.options.maxBytes - this.retainedRawBytes ||
							value.byteLength > this.options.maxTenantBytes - (this.tenantBytes.get(tenant) ?? 0)
						) {
							this.refused++;
							fail({ kind: "busy" });
							return;
						}
						retained += value.byteLength;
						this.retainedRawBytes += value.byteLength;
						this.tenantBytes.set(tenant, (this.tenantBytes.get(tenant) ?? 0) + value.byteLength);
						inputController?.enqueue(value);
						finishPull();
					}
				} catch (error) {
					while (!ended && !hasDemand()) await waitForInput();
					if (!ended) fail({ kind: "input_error", error });
				}
			};
			void pump();
		};
		try {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			try {
				releaseAdmission = await admission.acquire(key, key, 0, cancellation.signal, true, () => {
					demand = { kind: "queued" };
					startInput();
				});
				demand = { kind: "idle" };
			} catch (error) {
				if (failure === undefined) {
					if (this.closed) fail({ kind: "shutdown" });
					else if (error instanceof WorkerBusyError) fail({ kind: "busy" });
					else fail({ kind: "input_error", error });
				}
				return failureResponse();
			}
			if (this.closed) fail({ kind: "shutdown" });
			const rejected = failureResponse();
			if (rejected !== undefined) return rejected;
			startInput();
			const inputFailure = failureResponse();
			if (inputFailure !== undefined) return inputFailure;
			const outgoing: unknown = c.env?.outgoing;
			const nodeResponse =
				outgoing instanceof ServerResponse || outgoing instanceof Http2ServerResponse ? outgoing : undefined;
			if (nodeResponse !== undefined) {
				const releaseResponse = hold();
				const finish = () => {
					nodeResponse.removeListener("finish", finish);
					nodeResponse.removeListener("close", finish);
					nodeResponse.removeListener("error", finish);
					releaseResponse();
				};
				nodeResponse.once("finish", finish);
				nodeResponse.once("close", finish);
				nodeResponse.once("error", finish);
				if (nodeResponse.destroyed || nodeResponse.closed || nodeResponse.writableFinished) finish();
			}
			await ingressRetention.run({ hold }, next);
			const failed = failureResponse();
			if (failed !== undefined) c.res = failed;
			if (c.req.method === "HEAD") {
				void c.res.body?.cancel().catch(() => {});
			} else if (nodeResponse === undefined && c.res.body !== null) {
				const output = c.res.body.getReader();
				const releaseResponse = hold();
				let closed = false;
				let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
				const finish = () => {
					if (closed) return;
					closed = true;
					releaseResponse();
				};
				abortOutput = () => {
					if (closed) return;
					finish();
					outputController?.error(new DOMException("Request aborted", "AbortError"));
					void output.cancel().catch(() => {});
				};
				try {
					const streaming = new ReadableStream<Uint8Array>(
						{
							start(controller) {
								outputController = controller;
							},
							async pull(controller) {
								try {
									const { done, value } = await output.read();
									if (closed) return;
									if (done) {
										finish();
										controller.close();
									} else controller.enqueue(value);
								} catch (error) {
									finish();
									controller.error(error);
								}
							},
							cancel(reason) {
								finish();
								void output.cancel(reason).catch(() => {});
							},
						},
						{ highWaterMark: 0 },
					);
					c.res = new Response(streaming, c.res);
				} catch (error) {
					finish();
					void output.cancel().catch(() => {});
					throw error;
				}
			}
		} finally {
			release();
		}
	}
}
