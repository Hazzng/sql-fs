/**
 * Unit tests for production-stability lifecycle behaviors:
 *  - shutdown() disconnects every live FS
 *  - destroy() disconnects FS even when destroySandboxFn throws
 *  - getOrCreate() disconnects FS when post-build session construction fails
 *  - runtime semaphore waiters are removed on abort
 */

import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { RuntimeBackpressureError, SessionManager } from "../../session-manager.js";

const T = "tenantA";

interface FakeFs extends IFileSystem {
	disconnect: ReturnType<typeof vi.fn>;
}

function makeFakeFs(): FakeFs {
	const fs = new InMemoryFs() as unknown as FakeFs;
	fs.disconnect = vi.fn(() => Promise.resolve());
	return fs;
}

describe("SessionManager.shutdown", () => {
	it("stops the reaper, marks sessions closing, and disconnects every FS", async () => {
		const fs1 = makeFakeFs();
		const fs2 = makeFakeFs();
		const created: FakeFs[] = [];
		const createFs = vi.fn((_t: string, _s: string) => {
			const next = created.length === 0 ? fs1 : fs2;
			created.push(next);
			return Promise.resolve(next as IFileSystem);
		});
		const sm = new SessionManager({ createFs });
		sm.startReaper(60_000);

		await sm.getOrCreate(T, "sbx-1");
		await sm.getOrCreate(T, "sbx-2");

		await sm.shutdown({ drainTimeoutMs: 1_000 });

		expect(fs1.disconnect).toHaveBeenCalledTimes(1);
		expect(fs2.disconnect).toHaveBeenCalledTimes(1);
		expect(sm.getSession(T, "sbx-1")).toBeUndefined();
		expect(sm.getSession(T, "sbx-2")).toBeUndefined();
	});

	it("is idempotent", async () => {
		const fs1 = makeFakeFs();
		const sm = new SessionManager({ createFs: vi.fn(() => Promise.resolve(fs1 as IFileSystem)) });
		await sm.getOrCreate(T, "sbx-1");
		await sm.shutdown();
		await sm.shutdown();
		expect(fs1.disconnect).toHaveBeenCalledTimes(1);
	});
});

describe("SessionManager.destroy resilience", () => {
	it("disconnects FS even when destroySandboxFn throws", async () => {
		const fs1 = makeFakeFs();
		const sm = new SessionManager({
			createFs: vi.fn(() => Promise.resolve(fs1 as IFileSystem)),
			destroySandboxFn: vi.fn(() => Promise.reject(new Error("boom"))),
		});
		await sm.getOrCreate(T, "sbx");

		await expect(sm.destroy(T, "sbx")).rejects.toThrow("boom");
		// FS must still be disconnected — pool leak prevention is the point.
		expect(fs1.disconnect).toHaveBeenCalledTimes(1);
	});
});

describe("SessionManager.getOrCreate cleanup", () => {
	it("disconnects FS when session construction fails after buildFs", async () => {
		const fs1 = makeFakeFs();
		const sm = new SessionManager({
			createFs: vi.fn(() => Promise.resolve(fs1 as IFileSystem)),
		});
		// Force estimatePathCacheBytes to blow up by replacing fs.getAllPaths.
		(fs1 as unknown as { getAllPaths: () => string[] }).getAllPaths = () => {
			throw new Error("getAllPaths failed");
		};
		await expect(sm.getOrCreate(T, "sbx")).rejects.toThrow("getAllPaths failed");
		expect(fs1.disconnect).toHaveBeenCalledTimes(1);
	});
});

describe("Runtime semaphore abort + queue limits", () => {
	// Direct internal-API tests: we exercise the semaphore primitives
	// (acquireSlot/releaseSlot) rather than going through bash.exec, which
	// would require a runtime that actually blocks. The semaphore semantics
	// are independent of the runtime that runs after the slot is acquired.
	type SmInternals = {
		pythonSem: { inFlight: number; maxWaiters: number; waiters: unknown[] };
		acquireSlot(sem: unknown, signal?: AbortSignal): Promise<void>;
		releaseSlot(sem: unknown): void;
	};

	it("removes a queued waiter when the AbortSignal fires", async () => {
		const sm = new SessionManager({
			createFs: vi.fn(() => Promise.resolve(makeFakeFs() as IFileSystem)),
			maxConcurrentPython: 1,
		});
		const internals = sm as unknown as SmInternals;
		const sem = internals.pythonSem;

		await internals.acquireSlot(sem); // fill the only slot

		const ac = new AbortController();
		const queued = internals.acquireSlot(sem, ac.signal);
		expect(sem.waiters.length).toBe(1);

		ac.abort();
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		// Waiter must be removed from the queue, not retained in memory.
		expect(sem.waiters.length).toBe(0);
	});

	it("rejects with ERUNTIME_BUSY when queue is full", async () => {
		const sm = new SessionManager({
			createFs: vi.fn(() => Promise.resolve(makeFakeFs() as IFileSystem)),
			maxConcurrentPython: 1,
		});
		const internals = sm as unknown as SmInternals;
		const sem = internals.pythonSem;
		sem.maxWaiters = 1;

		await internals.acquireSlot(sem); // fill slot
		const queued = internals.acquireSlot(sem); // fill queue
		await expect(internals.acquireSlot(sem)).rejects.toBeInstanceOf(RuntimeBackpressureError);

		// Drain so the test doesn't leak unhandled rejections.
		internals.releaseSlot(sem);
		await queued;
	});
});
