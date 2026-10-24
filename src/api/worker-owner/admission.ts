import { WorkerBusyError } from "./protocol.js";

export interface AdmissionOptions {
	readonly capacity: number;
	readonly maxActivePerTenant: number;
	readonly maxQueued: number;
	readonly maxQueuedPerTenant: number;
	readonly maxQueuedBytes: number;
	readonly maxQueuedBytesPerTenant: number;
	readonly waitMs: number;
}

interface Waiter {
	readonly tenant: string;
	readonly key: string;
	readonly bytes: number;
	readonly shared: boolean;
	readonly resolve: (release: () => void) => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	timer?: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
}

export class FairAdmission {
	private readonly queues = new Map<string, Waiter[]>();
	private readonly activeKeys = new Map<string, { count: number; shared: boolean }>();
	private readonly activeTenants = new Map<string, number>();
	private active = 0;
	private queued = 0;
	private queuedBytes = 0;
	private closed = false;
	private lastTenant: string | undefined;
	private offered = 0;
	private admitted = 0;
	private refused = 0;
	private completed = 0;
	private totalWaitMs = 0;
	private cancelled = 0;
	private timedOut = 0;
	private readonly waitBuckets = [1, 5, 25, 100, 250, 1000, 2500, 5000, 10000, 30000];
	private readonly waitCounts = this.waitBuckets.map(() => 0);

	constructor(
		private readonly options: AdmissionOptions,
		private readonly tryReserve?: (key: string, shared: boolean) => (() => void) | undefined,
	) {}

	get metrics() {
		const sandboxWaiting = [...this.queues.values()].flat().filter((waiter) => this.activeKeys.has(waiter.key)).length;
		return {
			offered: this.offered,
			admitted: this.admitted,
			refused: this.refused,
			completed: this.completed,
			active: this.active,
			queued: this.queued,
			queuedBytes: this.queuedBytes,
			sandboxWaiting,
			runnableQueued: this.queued - sandboxWaiting,
			totalWaitMs: this.totalWaitMs,
			cancelled: this.cancelled,
			timedOut: this.timedOut,
			waitBuckets: this.waitBuckets.map((upperMs, index) => ({ upperMs, count: this.waitCounts[index] ?? 0 })),
		};
	}

	acquire(
		tenant: string,
		key: string,
		bytes: number,
		signal?: AbortSignal,
		shared = false,
		onQueued?: () => void,
	): Promise<() => void> {
		this.offered++;
		if (this.closed || signal?.aborted) {
			this.cancelled++;
			return Promise.reject(this.abortError());
		}
		this.drain();
		const queue = this.queues.get(tenant) ?? [];
		if (!queue.some((waiter) => waiter.key === key)) {
			const release = this.reserve(tenant, key, shared);
			if (release !== undefined) {
				this.recordWait(0);
				return Promise.resolve(release);
			}
		}
		const tenantQueuedBytes = queue.reduce((total, waiter) => total + waiter.bytes, 0);
		if (
			this.queued >= this.options.maxQueued ||
			queue.length >= this.options.maxQueuedPerTenant ||
			bytes > this.options.maxQueuedBytes - this.queuedBytes ||
			bytes > this.options.maxQueuedBytesPerTenant - tenantQueuedBytes
		) {
			this.refused++;
			return Promise.reject(new WorkerBusyError());
		}
		const started = performance.now();
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				tenant,
				key,
				bytes,
				shared,
				signal,
				resolve: (release) => {
					this.recordWait(performance.now() - started);
					resolve(release);
				},
				reject,
			};
			waiter.timer = setTimeout(() => {
				this.remove(waiter);
				this.refused++;
				this.timedOut++;
				reject(new WorkerBusyError());
				this.drain();
			}, this.options.waitMs);
			waiter.onAbort = () => {
				this.remove(waiter);
				this.cancelled++;
				reject(this.abortError());
				this.drain();
			};
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
			queue.push(waiter);
			this.queues.set(tenant, queue);
			this.queued++;
			this.queuedBytes += bytes;
			try {
				onQueued?.();
			} catch (error) {
				this.remove(waiter);
				this.cancelled++;
				reject(error);
			}
			this.drain();
		});
	}

	close(): void {
		this.closed = true;
		for (const queue of Array.from(this.queues.values())) {
			for (const waiter of queue.slice()) {
				this.remove(waiter);
				this.cancelled++;
				waiter.reject(Object.assign(new Error("ESHUTTINGDOWN: execution pool is draining"), { code: "ESHUTTINGDOWN" }));
			}
		}
	}

	wake(): void {
		this.drain();
	}

	private abortError(): Error {
		return Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" });
	}

	private recordWait(ms: number): void {
		this.totalWaitMs += ms;
		for (let index = 0; index < this.waitBuckets.length; index++) {
			if (ms <= (this.waitBuckets[index] ?? 0)) this.waitCounts[index] = (this.waitCounts[index] ?? 0) + 1;
		}
	}

	private reserve(tenant: string, key: string, shared: boolean): (() => void) | undefined {
		const tenantActive = this.activeTenants.get(tenant) ?? 0;
		if (tenantActive >= this.options.maxActivePerTenant) return undefined;
		const active = this.activeKeys.get(key);
		if (active !== undefined && (!shared || !active.shared)) return undefined;
		if (this.tryReserve === undefined && this.active >= this.options.capacity) return undefined;
		const releaseResource = this.tryReserve?.(key, shared);
		if (this.tryReserve !== undefined && releaseResource === undefined) return undefined;
		this.active++;
		this.admitted++;
		this.activeTenants.set(tenant, tenantActive + 1);
		this.activeKeys.set(key, { count: (active?.count ?? 0) + 1, shared });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.completed++;
			const currentTenantActive = this.activeTenants.get(tenant) ?? 0;
			if (currentTenantActive > 1) this.activeTenants.set(tenant, currentTenantActive - 1);
			else this.activeTenants.delete(tenant);
			const current = this.activeKeys.get(key);
			if (current !== undefined && current.count > 1) current.count--;
			else this.activeKeys.delete(key);
			releaseResource?.();
			this.drain();
		};
	}

	private remove(waiter: Waiter): void {
		const queue = this.queues.get(waiter.tenant);
		if (queue === undefined) return;
		const index = queue.indexOf(waiter);
		if (index < 0) return;
		queue.splice(index, 1);
		if (queue.length === 0) this.queues.delete(waiter.tenant);
		this.queued--;
		this.queuedBytes -= waiter.bytes;
		clearTimeout(waiter.timer);
		if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener("abort", waiter.onAbort);
	}

	private drain(): void {
		while (!this.closed && this.queued > 0) {
			const tenants = [...this.queues.keys()];
			const previous = this.lastTenant === undefined ? -1 : tenants.indexOf(this.lastTenant);
			let next: Waiter | undefined;
			let release: (() => void) | undefined;
			for (let offset = 1; offset <= tenants.length; offset++) {
				const tenant = tenants[(previous + offset) % tenants.length];
				if (tenant === undefined) continue;
				const waitingWriters = new Set<string>();
				for (const waiter of this.queues.get(tenant) ?? []) {
					if (waitingWriters.has(waiter.key)) continue;
					if (!waiter.shared) waitingWriters.add(waiter.key);
					release = this.reserve(waiter.tenant, waiter.key, waiter.shared);
					if (release !== undefined) {
						next = waiter;
						break;
					}
				}
				if (next !== undefined) break;
			}
			if (next === undefined) return;
			this.lastTenant = next.tenant;
			this.remove(next);
			if (release !== undefined) next.resolve(release);
		}
	}
}
