/**
 * Unit tests for SessionManager's parallel-readOnly bash exec entry point.
 *
 * Coverage:
 *  - Multiple withSessionRead calls run in parallel against the same sandbox.
 *  - withSessionRead waits for an in-flight write; a new write waits for
 *    in-flight readers.
 *  - The session FS is put into a read-only scope before fn runs and
 *    restored on exit; a violated flag surfaces EREADONLY_VIOLATION.
 *  - ensureFreshCache is single-flighted across parallel readers (one Redis
 *    GET, one reload).
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";

const T = "default";

/**
 * Minimal IReadOnlyScopeFs that piggybacks on InMemoryFs. Tracks scope
 * begin/end calls and exposes a `simulateViolation()` switch the test can
 * flip to mark the FS as having attempted a write under read-only scope.
 */
class TestReadOnlyFs {
	readonly inner: InMemoryFs;
	readOnlyScopeActive = false;
	readOnlyViolated = false;
	beginCount = 0;
	endCount = 0;
	constructor() {
		this.inner = new InMemoryFs();
	}
	beginReadOnlyScope(): void {
		if (this.readOnlyScopeActive) throw new Error("scope already active");
		this.readOnlyScopeActive = true;
		this.readOnlyViolated = false;
		this.beginCount++;
	}
	endReadOnlyScope(): void {
		this.readOnlyScopeActive = false;
		this.endCount++;
	}
	simulateViolation(): void {
		this.readOnlyViolated = true;
	}
}

function adaptReadOnlyFs(host: TestReadOnlyFs): IFileSystem {
	// Proxy: forward IFileSystem calls to InMemoryFs but expose the
	// IReadOnlyScopeFs surface (begin/end/active/violated) on the same
	// object so SessionManager's `asReadOnlyFs` duck-typed check sees it.
	const fs = host.inner as unknown as Record<string, unknown>;
	const merged = new Proxy(host as unknown as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			const v = fs[prop as string];
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(host.inner) : v;
		},
	});
	return merged as unknown as IFileSystem;
}

/** Minimal ICoherentFs around InMemoryFs so ensureFreshCache will probe Redis. */
class CoherentInMemoryFs {
	readonly inner: InMemoryFs;
	#dirty = false;
	reloadCount = 0;
	constructor() {
		this.inner = new InMemoryFs();
	}
	wasDirty(): boolean {
		return this.#dirty;
	}
	clearDirty(): void {
		this.#dirty = false;
	}
	async reload(): Promise<void> {
		this.reloadCount++;
	}
}

function adaptCoherentFs(host: CoherentInMemoryFs): IFileSystem {
	const fs = host.inner as unknown as Record<string, unknown>;
	return new Proxy(host as unknown as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			const v = fs[prop as string];
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(host.inner) : v;
		},
	}) as unknown as IFileSystem;
}

describe("SessionManager.withSessionRead", () => {
	it("multiple readOnly calls run in parallel on the same sandbox", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		await sm.getOrCreate(T, "sb-parallel");

		let active = 0;
		let peak = 0;
		const work = async (): Promise<void> => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setImmediate(r));
			active--;
		};

		await Promise.all([
			sm.withSessionRead(T, "sb-parallel", work),
			sm.withSessionRead(T, "sb-parallel", work),
			sm.withSessionRead(T, "sb-parallel", work),
			sm.withSessionRead(T, "sb-parallel", work),
		]);

		expect(peak).toBeGreaterThanOrEqual(2); // at minimum, parallel
		expect(peak).toBe(4); // exact: all four ran simultaneously
	});

	it("readOnly waits for an in-flight writer", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		await sm.getOrCreate(T, "sb-w-blocks-r");
		const order: string[] = [];

		let releaseW!: () => void;
		const writer = sm.withSession(T, "sb-w-blocks-r", async () => {
			order.push("w-start");
			await new Promise<void>((r) => {
				releaseW = r;
			});
			order.push("w-end");
		});

		// Wait for writer to enter
		await new Promise((r) => setImmediate(r));

		const reader = sm.withSessionRead(T, "sb-w-blocks-r", async () => {
			order.push("r-start");
			order.push("r-end");
		});

		await new Promise((r) => setImmediate(r));
		expect(order).toEqual(["w-start"]);

		releaseW();
		await Promise.all([writer, reader]);
		expect(order).toEqual(["w-start", "w-end", "r-start", "r-end"]);
	});

	it("a writer waits for in-flight readers and queues new readers behind it", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		await sm.getOrCreate(T, "sb-r-blocks-w");
		const order: string[] = [];

		let releaseR1!: () => void;
		const reader1 = sm.withSessionRead(T, "sb-r-blocks-w", async () => {
			order.push("r1-start");
			await new Promise<void>((r) => {
				releaseR1 = r;
			});
			order.push("r1-end");
		});
		await new Promise((r) => setImmediate(r));

		const writer = sm.withSession(T, "sb-r-blocks-w", async () => {
			order.push("w-acquired");
		});
		await new Promise((r) => setImmediate(r));

		// New reader must wait behind the queued writer (writer-priority)
		const reader2 = sm.withSessionRead(T, "sb-r-blocks-w", async () => {
			order.push("r2-acquired");
		});
		await new Promise((r) => setImmediate(r));
		expect(order).toEqual(["r1-start"]);

		releaseR1();
		await Promise.all([reader1, writer, reader2]);
		expect(order).toEqual(["r1-start", "r1-end", "w-acquired", "r2-acquired"]);
	});

	it("opens and closes the read-only scope around fn on a scoped FS", async () => {
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-scope");

		let activeDuringFn: boolean | undefined;
		await sm.withSessionRead(T, "sb-scope", async () => {
			activeDuringFn = host.readOnlyScopeActive;
		});
		expect(activeDuringFn).toBe(true);
		expect(host.readOnlyScopeActive).toBe(false);
		expect(host.beginCount).toBe(1);
		expect(host.endCount).toBe(1);
	});

	it("surfaces EREADONLY_VIOLATION when fn returns successfully but the FS recorded a violation", async () => {
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-violation");

		await expect(
			sm.withSessionRead(T, "sb-violation", async () => {
				host.simulateViolation();
			}),
		).rejects.toMatchObject({ code: "EREADONLY_VIOLATION" });

		// Scope is still closed even on the violation throw
		expect(host.readOnlyScopeActive).toBe(false);
		expect(host.endCount).toBe(1);
	});

	it("preserves the original error when fn throws even if a violation was recorded", async () => {
		const host = new TestReadOnlyFs();
		const sm = new SessionManager({ createFs: async () => adaptReadOnlyFs(host) });
		await sm.getOrCreate(T, "sb-violation-throw");

		await expect(
			sm.withSessionRead(T, "sb-violation-throw", async () => {
				host.simulateViolation();
				throw new Error("script blew up");
			}),
		).rejects.toThrow("script blew up");
		expect(host.readOnlyScopeActive).toBe(false);
	});

	it("single-flights ensureFreshCache across parallel readers", async () => {
		// Fake Redis that records every GET. The probe done by getOrCreate
		// for the initial version returns immediately; the probes done by
		// ensureFreshCache for the parallel readers block on `block` so we
		// can observe how many concurrent GETs are in-flight.
		const getCalls: string[] = [];
		let blockReads = false;
		let onceResolve!: () => void;
		const block = new Promise<void>((r) => {
			onceResolve = r;
		});
		const fakeRedis: Partial<Redis> = {
			get: vi.fn(async (key: string) => {
				getCalls.push(key);
				if (blockReads) await block;
				return "0";
			}),
			incr: vi.fn(async () => 1),
			expire: vi.fn(async () => 1),
		};

		const host = new CoherentInMemoryFs();
		const sm = new SessionManager({
			createFs: async () => adaptCoherentFs(host),
			redis: fakeRedis as Redis,
		});
		await sm.getOrCreate(T, "sb-single-flight");
		const initialGets = getCalls.length;
		blockReads = true;

		// Five readers in flight before the first GET resolves.
		const readers = Array.from({ length: 5 }, () => sm.withSessionRead(T, "sb-single-flight", async () => "ok"));

		// Let the readers reach ensureFreshCache.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		// All five share one in-flight GET (single-flight ensureFreshCache).
		expect(getCalls.length - initialGets).toBe(1);

		onceResolve();
		await Promise.all(readers);
		// And no extra GET was issued for the rest of the cohort.
		expect(getCalls.length - initialGets).toBe(1);

		await sm.shutdown();
	});
});
