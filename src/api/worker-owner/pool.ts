import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { retirePostgresSandboxGeneration } from "../../sql-fs/index.js";
import type { ScriptTxBufferConfig } from "../../sql-fs/script-tx-buffer.js";
import { positiveIntEnv } from "../lib/env.js";
import { readOnlyContext } from "../read-only-context.js";
import { FairAdmission } from "./admission.js";
import { assertWorkerMessageBudget } from "./message-budget.js";
import {
	OutcomeUnknownError,
	type OwnerCommand,
	type OwnerCommandKind,
	type OwnerEvent,
	type OwnerIdentity,
	type OwnerMetadata,
	type OwnerReply,
	type OwnerRequest,
	type OwnerResult,
	type ShellExecutionLimits,
	mayApply,
} from "./protocol.js";
import { workerRequestContext } from "./request-context.js";
import { RequestOutcome, workerFailureCode } from "./request-outcome.js";

export interface WorkerPoolOptions {
	readonly count: number;
	readonly maxActivePerTenant: number;
	readonly heapMb: number;
	readonly maxQueued: number;
	readonly maxQueuedPerTenant: number;
	readonly maxQueuedBytes: number;
	readonly maxQueuedBytesPerTenant: number;
	readonly waitMs: number;
	readonly cancelGraceMs: number;
	readonly startupMs: number;
	readonly maxRssBytes: number;
	readonly maxExternalBytes: number;
	readonly defenseInDepth: boolean;
	readonly defenseAuditMode: boolean;
	readonly executionLimits: ShellExecutionLimits;
	readonly execFileLimitBytes: number | null;
	readonly scriptTxBuffer: ScriptTxBufferConfig;
	readonly pgPoolMax: number;
	readonly maxPgConnections: number;
}

function configuredInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const value = env[name];
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function assertActiveTenantLimit(count: number, limit: number): void {
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new Error("SQL_FS_WORKER_ACTIVE_TENANT_MAX must be a positive integer");
	}
	if (limit > Math.max(1, count - 1)) {
		throw new Error("SQL_FS_WORKER_ACTIVE_TENANT_MAX must leave a worker for other tenants when count is at least 2");
	}
}

function assertQueuedTenantByteLimit(total: number, limit: number): void {
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new Error("SQL_FS_WORKER_QUEUE_TENANT_BYTES must be a positive integer");
	}
	if (limit > Math.max(1, total - 1)) {
		throw new Error(
			"SQL_FS_WORKER_QUEUE_TENANT_BYTES must leave queue bytes for other tenants when total is at least 2",
		);
	}
}

function assertQueuedTenantLimit(total: number, limit: number): void {
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new Error("SQL_FS_WORKER_QUEUE_TENANT_MAX must be a positive integer");
	}
	if (limit > Math.max(1, total - 1)) {
		throw new Error(
			"SQL_FS_WORKER_QUEUE_TENANT_MAX must leave queue capacity for other tenants when total is at least 2",
		);
	}
}

function workerHostResources(): { cpus: number; memoryBytes: number } {
	let quotaCpus = 0;
	try {
		const membership = readFileSync("/proc/self/cgroup", "utf8");
		if (membership === "0::/" || membership === "0::/\n") {
			const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
			quotaCpus = quota === "max" ? availableParallelism() : Number(quota) / Number(period);
		}
	} catch {
		quotaCpus = 0;
	}
	return { cpus: Math.min(availableParallelism(), quotaCpus), memoryBytes: process.constrainedMemory() };
}

export function loadWorkerPoolOptions(
	env: NodeJS.ProcessEnv = process.env,
	resources?: { cpus: number; memoryBytes: number },
): WorkerPoolOptions {
	const mib = 1024 * 1024;
	const largeFiles = env.SQL_FS_WORKER_LARGE_FILES;
	if (largeFiles !== undefined && largeFiles !== "true" && largeFiles !== "false") {
		throw new Error("SQL_FS_WORKER_LARGE_FILES must be true or false");
	}
	const count = configuredInteger(env, "SQL_FS_WORKER_COUNT", 2);
	const maxQueued = configuredInteger(env, "SQL_FS_WORKER_QUEUE_MAX", 32);
	const maxQueuedBytes = configuredInteger(env, "SQL_FS_WORKER_QUEUE_BYTES", 64 * mib);
	const options = {
		count,
		maxActivePerTenant: configuredInteger(env, "SQL_FS_WORKER_ACTIVE_TENANT_MAX", Math.max(1, Math.floor(count / 2))),
		heapMb: configuredInteger(env, "SQL_FS_WORKER_HEAP_MB", 512),
		maxQueued,
		maxQueuedPerTenant: configuredInteger(
			env,
			"SQL_FS_WORKER_QUEUE_TENANT_MAX",
			Math.min(8, Math.max(1, Math.floor(maxQueued / 2))),
		),
		maxQueuedBytes,
		maxQueuedBytesPerTenant: configuredInteger(
			env,
			"SQL_FS_WORKER_QUEUE_TENANT_BYTES",
			Math.max(1, Math.floor(maxQueuedBytes / 2)),
		),
		waitMs: configuredInteger(env, "SQL_FS_WORKER_QUEUE_WAIT_MS", 250),
		cancelGraceMs: configuredInteger(env, "SQL_FS_WORKER_CANCEL_GRACE_MS", 500),
		startupMs: configuredInteger(env, "SQL_FS_WORKER_STARTUP_MS", 10_000),
		maxRssBytes: configuredInteger(env, "SQL_FS_WORKER_MAX_RSS_BYTES", 1536 * 1024 * 1024),
		maxExternalBytes: configuredInteger(env, "SQL_FS_WORKER_MAX_EXTERNAL_BYTES", 512 * 1024 * 1024),
		defenseInDepth: env.JUST_BASH_DEFENSE_IN_DEPTH === "true",
		defenseAuditMode: env.JUST_BASH_DEFENSE_AUDIT_MODE !== "false",
		pgPoolMax: configuredInteger(env, "SQL_FS_WORKER_PG_POOL_MAX", 2),
		maxPgConnections: configuredInteger(env, "SQL_FS_WORKER_MAX_PG_CONNECTIONS", 4),
		execFileLimitBytes:
			largeFiles === "true" && env.MAX_EXEC_FILE_BYTES === undefined
				? null
				: positiveIntEnv(env.MAX_EXEC_FILE_BYTES, 8 * mib),
		executionLimits: {
			maxSourceBytes: configuredInteger(env, "SQL_FS_WORKER_SOURCE_BYTES", mib),
			maxStringLength: configuredInteger(env, "SQL_FS_WORKER_STRING_CHARS", 64 * mib),
			maxInputBytes: configuredInteger(env, "SQL_FS_WORKER_INPUT_BYTES", 128 * mib),
			maxOutputSize: configuredInteger(env, "SQL_FS_WORKER_OUTPUT_BYTES", 64 * mib),
			maxLiveBytes: configuredInteger(env, "SQL_FS_WORKER_LIVE_BYTES", 128 * mib),
			maxWorkerMessageBytes: configuredInteger(env, "SQL_FS_WORKER_MESSAGE_BYTES", 65 * mib),
			maxPythonBridgeBytes: configuredInteger(env, "SQL_FS_WORKER_PYTHON_BRIDGE_BYTES", 64 * mib),
			maxExecutionTimeMs: configuredInteger(env, "SQL_FS_WORKER_EXECUTION_MS", 120_000),
		},
		scriptTxBuffer: {
			enabled: env.SCRIPT_TX_BUFFERED !== "false",
			maxOps: configuredInteger(env, "SQL_FS_WORKER_SCRIPT_BUFFER_OPS", 50_000),
			maxBytes: configuredInteger(env, "SQL_FS_WORKER_SCRIPT_BUFFER_BYTES", 32 * mib),
		},
	};
	assertActiveTenantLimit(options.count, options.maxActivePerTenant);
	assertQueuedTenantLimit(options.maxQueued, options.maxQueuedPerTenant);
	assertQueuedTenantByteLimit(options.maxQueuedBytes, options.maxQueuedBytesPerTenant);
	if (options.count * options.pgPoolMax > options.maxPgConnections) {
		throw new Error("Worker count times PG pool size exceeds SQL_FS_WORKER_MAX_PG_CONNECTIONS");
	}
	if (options.count * options.heapMb * mib >= options.maxRssBytes) {
		throw new Error("Worker heap limits must leave RSS headroom for the parent and external allocations");
	}
	if (options.execFileLimitBytes === null) {
		const host = resources ?? workerHostResources();
		if (!(host.cpus >= 2) || !(host.memoryBytes >= 3 * 1024 ** 3)) {
			throw new Error("Worker large-file execution requires at least 2 CPUs and a 3 GiB memory limit");
		}
		if (
			options.maxRssBytes < 2304 * mib ||
			options.maxRssBytes >= host.memoryBytes ||
			options.maxExternalBytes < 1024 * mib
		) {
			throw new Error("Worker large-file memory thresholds require at least 2.25 GiB RSS and 1 GiB external headroom");
		}
	}
	return options;
}

interface PendingReply {
	readonly resolve: (reply: OwnerReply) => void;
	readonly reject: (error: Error) => void;
	readonly safeToRetry: boolean;
}

class OwnerThread {
	private readonly worker: Worker;
	private readonly pending = new Map<number, PendingReply>();
	private state: "open" | "dead" = "open";
	private sequence = 0;
	private termination?: Promise<number>;
	readonly ready: Promise<void>;
	private readyResolve?: () => void;
	private readyReject?: (error: Error) => void;
	private initialized = false;
	private readonly startupTimer: ReturnType<typeof setTimeout>;

	constructor(private readonly options: WorkerPoolOptions) {
		this.ready = new Promise((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		this.ready.catch(() => {});
		const compiledRuntime = new URL("./runtime.js", import.meta.url);
		const sourceRuntime = !existsSync(compiledRuntime);
		const runtime = sourceRuntime ? new URL("./runtime.ts", import.meta.url) : compiledRuntime;
		const bootstrap =
			'const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ register }) => { register(); return import(workerData.runtime); });';
		this.worker = new Worker(sourceRuntime ? bootstrap : runtime, {
			eval: sourceRuntime,
			workerData: { options, runtime: runtime.href },
			resourceLimits: { maxOldGenerationSizeMb: options.heapMb },
			execArgv: sourceRuntime ? [] : process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
		});
		this.startupTimer = setTimeout(() => void this.terminate(), options.startupMs);
		this.worker.on("message", (reply: OwnerEvent) => {
			if ("kind" in reply) {
				clearTimeout(this.startupTimer);
				this.initialized = true;
				this.readyResolve?.();
				this.readyResolve = undefined;
				this.readyReject = undefined;
				return;
			}
			const waiter = this.pending.get(reply.id);
			if (waiter === undefined) return;
			this.pending.delete(reply.id);
			waiter.resolve(reply);
		});
		this.worker.on("error", () => this.fail());
		this.worker.on("exit", () => this.fail());
	}

	get dead(): boolean {
		return this.state === "dead";
	}

	get available(): boolean {
		return this.initialized && !this.dead;
	}

	async request<K extends OwnerCommandKind>(
		generation: number,
		command: OwnerCommand<K>,
		readOnly: boolean,
		lostSignal?: AbortSignal,
		signal?: AbortSignal,
		onDispatch?: () => void,
	): Promise<OwnerReply> {
		if (this.dead) throw this.failure(true);
		assertWorkerMessageBudget(command, this.options.executionLimits.maxWorkerMessageBytes ?? 64 * 1024 * 1024);
		if (signal?.aborted && command.kind !== "endScope") {
			throw Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" });
		}
		const cancellation = new SharedArrayBuffer(8);
		const words = new Int32Array(cancellation);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = (): void => {
			Atomics.store(words, 0, 1);
			if (timer === undefined) timer = setTimeout(() => void this.terminate(), this.options.cancelGraceMs);
		};
		const lose = (): void => {
			Atomics.store(words, 1, 1);
			abort();
		};
		signal?.addEventListener("abort", abort, { once: true });
		lostSignal?.addEventListener("abort", lose, { once: true });
		if (lostSignal?.aborted) lose();
		const id = ++this.sequence;
		try {
			return await new Promise<OwnerReply>((resolve, reject) => {
				this.pending.set(id, {
					resolve,
					reject,
					safeToRetry: !mayApply(command),
				});
				const request: OwnerRequest<K> = { id, generation, command, readOnly, cancellation };
				try {
					this.worker.postMessage(request);
					onDispatch?.();
				} catch {
					this.pending.delete(id);
					reject(this.failure(true));
				}
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			lostSignal?.removeEventListener("abort", lose);
		}
	}

	terminate(): Promise<number> {
		this.fail();
		this.termination ??= this.worker.terminate();
		return this.termination;
	}

	private failure(safeToRetry: boolean): Error {
		return safeToRetry
			? Object.assign(new Error("EWORKER_UNAVAILABLE: read worker stopped; no write was dispatched"), {
					code: "EWORKER_UNAVAILABLE",
				})
			: new OutcomeUnknownError();
	}

	private fail(): void {
		if (this.dead) return;
		this.state = "dead";
		clearTimeout(this.startupTimer);
		this.readyReject?.(this.failure(true));
		this.readyReject = undefined;
		this.readyResolve = undefined;
		for (const waiter of this.pending.values()) waiter.reject(this.failure(waiter.safeToRetry));
		this.pending.clear();
	}
}

interface WorkerSlot {
	thread?: OwnerThread;
	residentKey?: string;
	activeKey?: string;
	readers: number;
	shared: boolean;
	generation: number;
	attach?: Promise<void>;
	metadata?: OwnerMetadata;
	external: number;
	retiring?: boolean;
}

interface WorkerReservation {
	readonly key: string;
	readonly slot: WorkerSlot;
	lostSignal?: AbortSignal;
	identity?: OwnerIdentity;
	phase: "lock_wait" | "running" | "recovering";
	readonly outcome: RequestOutcome;
	recovery?: { readonly generation: number; readonly task: Promise<void> };
}

export class WorkerOwnerPool {
	private readonly reservationContext = new AsyncLocalStorage<WorkerReservation>();
	private readonly slots: WorkerSlot[];
	private readonly admission: FairAdmission;
	private readonly reservations = new Map<string, WorkerSlot>();
	private closing = false;
	private restarts = 0;
	private unknownOutcomes = 0;
	private readonly liveReservations = new Set<WorkerReservation>();
	private pressureRecovery?: Promise<void>;

	constructor(readonly options: WorkerPoolOptions) {
		assertActiveTenantLimit(options.count, options.maxActivePerTenant);
		assertQueuedTenantLimit(options.maxQueued, options.maxQueuedPerTenant);
		assertQueuedTenantByteLimit(options.maxQueuedBytes, options.maxQueuedBytesPerTenant);
		this.slots = Array.from({ length: options.count }, () => ({
			readers: 0,
			shared: false,
			generation: 0,
			external: 0,
		}));
		this.admission = new FairAdmission({ ...options, capacity: options.count }, (key, shared) =>
			this.reserveSlot(key, shared),
		);
	}

	get metrics() {
		return {
			...this.admission.metrics,
			workers: this.slots.length,
			readyWorkers: this.slots.filter((slot) => slot.thread?.available).length,
			busyWorkers: this.slots.filter((slot) => slot.readers > 0).length,
			residentSessions: this.slots.filter((slot) => slot.residentKey !== undefined).length,
			externalBytes: this.slots.reduce((sum, slot) => sum + slot.external, 0),
			rssBytes: process.memoryUsage().rss,
			restarts: this.restarts,
			unknownOutcomes: this.unknownOutcomes,
			lockWaiting: [...this.liveReservations].filter((reservation) => reservation.phase === "lock_wait").length,
			runningOperations: [...this.liveReservations].filter((reservation) => reservation.phase === "running").length,
			recoveringOperations: [...this.liveReservations].filter((reservation) => reservation.phase === "recovering")
				.length,
		};
	}

	async start(): Promise<void> {
		await Promise.all(
			this.slots.map(async (slot) => {
				slot.thread ??= new OwnerThread(this.options);
				await slot.thread.ready;
			}),
		);
	}

	async run<T>(tenant: string, key: string, shared: boolean, fn: () => Promise<T>, bytes = 1024): Promise<T> {
		const existing = this.reservationContext.getStore();
		if (existing?.key === key) return fn();
		if (this.closing)
			throw Object.assign(new Error("ESHUTTINGDOWN: execution pool is draining"), { code: "ESHUTTINGDOWN" });
		await this.releaseIdleMemory();
		const context = workerRequestContext.getStore();
		const release = await this.admission.acquire(
			tenant,
			key,
			Math.max(bytes, context?.bytes ?? 0),
			context?.signal,
			shared,
		);
		const slot = this.reservations.get(key);
		if (slot === undefined) {
			release();
			throw new Error("missing worker reservation");
		}
		const reservation: WorkerReservation = {
			key,
			slot,
			phase: "lock_wait",
			outcome: new RequestOutcome(),
		};
		this.liveReservations.add(reservation);
		try {
			return await this.reservationContext.run(reservation, fn);
		} finally {
			this.liveReservations.delete(reservation);
			release();
		}
	}

	async attach(identity: OwnerIdentity): Promise<OwnerMetadata> {
		const reservation = this.current();
		reservation.identity = identity;
		const slot = reservation.slot;
		slot.attach ??= (async () => {
			if (slot.thread?.dead) {
				await slot.thread.terminate();
				slot.thread = undefined;
				slot.residentKey = undefined;
				slot.metadata = undefined;
				slot.external = 0;
				this.restarts++;
			}
			if (this.closing)
				throw Object.assign(new Error("ESHUTTINGDOWN: execution pool is draining"), { code: "ESHUTTINGDOWN" });
			slot.thread ??= new OwnerThread(this.options);
			await slot.thread.ready;
			if (slot.residentKey !== reservation.key) {
				if (slot.residentKey !== undefined) {
					await this.send({ kind: "disconnect" }, undefined, true);
					slot.residentKey = undefined;
					slot.metadata = undefined;
				}
				slot.generation++;
				await this.send({ kind: "attach", identity }, undefined, true);
				slot.residentKey = reservation.key;
			}
		})();
		const attached = slot.attach;
		try {
			await attached;
		} finally {
			if (slot.attach === attached) slot.attach = undefined;
		}
		if (slot.metadata === undefined) throw new Error("worker did not return resident metadata");
		return slot.metadata;
	}

	async send<K extends OwnerCommandKind>(
		command: OwnerCommand<K>,
		signal?: AbortSignal,
		forceReadOnly?: boolean,
	): Promise<OwnerResult<K>> {
		const reservation = this.current();
		const { slot, lostSignal } = reservation;
		if (slot.thread === undefined) throw new Error("worker owner is not attached");
		const ctx = readOnlyContext.getStore();
		let reply: OwnerReply;
		try {
			reply = await slot.thread.request(
				slot.generation,
				command,
				forceReadOnly ?? ctx !== undefined,
				lostSignal,
				signal,
				() => reservation.outcome.dispatched(command),
			);
		} catch (error) {
			throw reservation.outcome.transportFailure(error);
		}
		if (reply.generation !== slot.generation) throw new OutcomeUnknownError();
		if (reply.metadata !== undefined) slot.metadata = reply.metadata;
		slot.external = reply.memory.external;
		if (ctx !== undefined && reply.readOnlyViolated) ctx.violated = true;
		if (!reply.ok)
			throw Object.assign(new Error(reply.error.message), { name: reply.error.name, code: reply.error.code });
		reservation.outcome.acknowledged(command, ctx !== undefined);
		return reply.value as OwnerResult<K>;
	}

	get metadata(): OwnerMetadata | undefined {
		return this.current().slot.metadata;
	}

	hasReservation(key?: string): boolean {
		const current = this.reservationContext.getStore();
		return current !== undefined && (key === undefined || current.key === key);
	}

	markRunning(signal?: AbortSignal): void {
		const current = this.reservationContext.getStore();
		if (current === undefined) return;
		current.lostSignal = signal;
		current.phase = "running";
	}

	async withLease<T>(signal: AbortSignal | undefined, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
		const current = this.reservationContext.getStore();
		if (current === undefined) return fn(signal);
		current.lostSignal = signal;
		let result: T;
		try {
			result = await fn(signal);
		} catch (error) {
			if (signal?.aborted || workerFailureCode(error) === "ELOCKLOST") await this.leaseLostAfterWork(error);
			throw current.outcome.runtimeFailure(error);
		}
		if (signal?.aborted) await this.leaseLostAfterWork();
		return result;
	}

	async leaseLostAfterWork(error?: unknown): Promise<void> {
		const failure = this.reservationContext.getStore()?.outcome.leaseLoss(error);
		if (failure === undefined) return;
		try {
			await this.recover(new OutcomeUnknownError());
		} catch {}
		throw failure;
	}

	async recover(error: unknown): Promise<void> {
		const code = workerFailureCode(error);
		if (code !== "EEXEC_OUTCOME_UNKNOWN" && code !== "EWORKER_UNAVAILABLE") return;
		const reservation = this.reservationContext.getStore();
		if (reservation === undefined) return;
		const { slot, identity } = reservation;
		const { generation, thread } = slot;
		if (reservation.recovery?.generation === generation) return reservation.recovery.task;
		const task = (async () => {
			if (code === "EEXEC_OUTCOME_UNKNOWN") this.unknownOutcomes++;
			reservation.phase = "recovering";
			await thread?.terminate();
			if (slot.generation === generation && slot.thread === thread) {
				slot.residentKey = undefined;
				slot.metadata = undefined;
			}
			if (identity !== undefined) {
				await retirePostgresSandboxGeneration(identity.connectionString, identity.sandboxId);
			}
		})();
		reservation.recovery = { generation, task };
		await task;
	}

	async disconnect(key: string): Promise<void> {
		const current = this.reservationContext.getStore();
		if (current?.key === key && current.slot.readers === 1 && current.slot.residentKey === key) {
			await this.send({ kind: "disconnect" }, undefined, true);
			current.slot.residentKey = undefined;
			current.slot.metadata = undefined;
			return;
		}
		for (const slot of this.slots) {
			if (slot.residentKey !== key || slot.readers !== 0) continue;
			await slot.thread?.terminate();
			slot.residentKey = undefined;
			slot.metadata = undefined;
		}
	}

	async shutdown(drainMs: number): Promise<void> {
		this.closing = true;
		this.admission.close();
		const deadline = Date.now() + drainMs;
		while (this.slots.some((slot) => slot.readers > 0) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await Promise.all(
			this.slots.map(async (slot) => {
				const thread = slot.thread;
				if (thread === undefined) return;
				if (slot.readers === 0 && thread.available) {
					const abort = new AbortController();
					const timer = setTimeout(() => abort.abort(), this.options.cancelGraceMs);
					try {
						await thread.request(slot.generation, { kind: "shutdown" }, true, undefined, abort.signal);
					} catch {
					} finally {
						clearTimeout(timer);
					}
				}
				await thread.terminate();
			}),
		);
	}

	async crashWorkerForTest(key: string): Promise<void> {
		const slot = this.slots.find((candidate) => candidate.activeKey === key || candidate.residentKey === key);
		await slot?.thread?.terminate();
	}

	private current(): WorkerReservation {
		const current = this.reservationContext.getStore();
		if (current === undefined) throw new Error("worker filesystem requires an admitted session operation");
		return current;
	}

	private reserveSlot(key: string, shared: boolean): (() => void) | undefined {
		if (this.underMemoryPressure()) return undefined;
		const existing = this.reservations.get(key);
		let slot = existing;
		if (slot !== undefined && (!shared || !slot.shared || slot.readers >= 8)) return undefined;
		if (slot === undefined) {
			slot =
				this.slots.find(
					(candidate) => candidate.readers === 0 && !candidate.retiring && candidate.residentKey === key,
				) ?? this.slots.find((candidate) => candidate.readers === 0 && !candidate.retiring);
			if (slot === undefined) return undefined;
			slot.shared = shared;
			slot.activeKey = key;
			this.reservations.set(key, slot);
		}
		slot.readers++;
		const selected = slot;
		return () => {
			selected.readers--;
			if (selected.readers !== 0) return;
			selected.activeKey = undefined;
			this.reservations.delete(key);
			void this.releaseIdleMemory();
		};
	}

	private underMemoryPressure(): boolean {
		return (
			process.memoryUsage().rss >= this.options.maxRssBytes ||
			this.metrics.externalBytes >= this.options.maxExternalBytes
		);
	}

	private releaseIdleMemory(): Promise<void> {
		if (this.pressureRecovery !== undefined) return this.pressureRecovery;
		if (!this.underMemoryPressure()) return Promise.resolve();
		const idle = this.slots.filter((slot) => slot.readers === 0 && slot.thread !== undefined && !slot.retiring);
		for (const slot of idle) slot.retiring = true;
		this.pressureRecovery = Promise.all(
			idle.map(async (slot) => {
				await slot.thread?.terminate();
				slot.thread = undefined;
				slot.residentKey = undefined;
				slot.metadata = undefined;
				slot.external = 0;
				slot.retiring = false;
				this.restarts++;
			}),
		)
			.then(() => {})
			.finally(() => {
				this.pressureRecovery = undefined;
				this.admission.wake();
			});
		return this.pressureRecovery;
	}
}
