/**
 * Unit tests for production-stability lifecycle behaviors:
 *  - shutdown() disconnects every live FS
 *  - destroy() disconnects FS even when destroySandboxFn throws
 *  - getOrCreate() disconnects FS when post-build session construction fails
 *  - runtime semaphore waiters are removed on abort
 */

import type { IFileSystem } from "just-bash";
import { defineCommand, InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeBackpressureError, SessionManager } from "../../session-manager.js";
import type { OwnerMetadata } from "../../worker-owner/protocol.js";

const T = "tenantA";

afterEach(() => vi.unstubAllEnvs());

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

	it("refuses worker sessions whose attachment completes after shutdown", async () => {
		let completeAttach!: (metadata: OwnerMetadata) => void;
		let attached!: () => void;
		const attaching = new Promise<void>((resolve) => {
			attached = resolve;
		});
		const attachment = new Promise<OwnerMetadata>((resolve) => {
			completeAttach = resolve;
		});
		const pool = {
			hasReservation: () => true,
			attach: async () => {
				attached();
				return attachment;
			},
			shutdown: vi.fn(async () => {}),
			disconnect: vi.fn(async () => {}),
		};
		const sm = new SessionManager({
			createFs: async () => makeFakeFs(),
			workerEnabled: false,
			tenantConfig: { tenantIds: [T], hasTenant: () => true, getConnectionString: () => "unused-in-this-unit-test" },
		});
		Object.assign(sm, { workerPool: pool });
		const creation = sm.getOrCreate(T, "worker-race");
		await attaching;
		await sm.shutdown();
		const assertion = expect(creation).rejects.toMatchObject({ code: "ESHUTTINGDOWN" });
		completeAttach({
			owner: "owner",
			createdAt: "2026-10-13T00:00:00.000Z",
			cwd: "/home/user",
			dirty: false,
			poisoned: false,
			pathCacheBytes: 0,
		});
		await assertion;
		expect(sm.getSession(T, "worker-race")).toBeUndefined();
		expect(pool.disconnect).toHaveBeenCalledExactlyOnceWith(`${T}:worker-race`);
	});

	it("is idempotent", async () => {
		const fs1 = makeFakeFs();
		const sm = new SessionManager({ createFs: vi.fn(() => Promise.resolve(fs1 as IFileSystem)) });
		await sm.getOrCreate(T, "sbx-1");
		await sm.shutdown();
		await sm.shutdown();
		expect(fs1.disconnect).toHaveBeenCalledTimes(1);
	});

	it.each([80, 100])("shares one drain budget when workers take %i ms", async (workerDrainMs) => {
		const fs = makeFakeFs();
		const sm = new SessionManager({ createFs: async () => fs, workerEnabled: false });
		const session = await sm.getOrCreate(T, "held-session");
		let releaseLock!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const operation = session.lock.runExclusive(() => held);
		await Promise.resolve();
		const workerShutdown = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, workerDrainMs)));
		(sm as unknown as { workerPool: { shutdown: typeof workerShutdown } }).workerPool = { shutdown: workerShutdown };
		vi.useFakeTimers();
		let completed = false;
		const shutdown = sm.shutdown({ drainTimeoutMs: 100 }).then(() => {
			completed = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(99);
			expect(completed).toBe(false);
			expect(fs.disconnect).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(3);
			expect(completed).toBe(true);
			expect(session.lock.writerHeld).toBe(true);
			expect(fs.disconnect).toHaveBeenCalledTimes(1);
			expect(sm.getSession(T, "held-session")).toBeUndefined();
			expect(workerShutdown).toHaveBeenCalledWith(100);
		} finally {
			releaseLock();
			await operation;
			await vi.runAllTimersAsync();
			await shutdown;
			vi.useRealTimers();
		}
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
	async function holdRuntime(sm: SessionManager) {
		const session = await sm.getOrCreate(T, "held", { python: true, javascript: false, network: false });
		let release!: () => void;
		let entered!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		session.bash.registerCommand(
			defineCommand("hold-runtime", async () => {
				entered();
				await held;
				return { stdout: "released", stderr: "", exitCode: 0 };
			}),
		);
		const operation = sm.execWithRuntimeThrottle(session, "hold-runtime");
		await ready;
		return { release, operation };
	}

	it("removes a queued waiter when the AbortSignal fires", async () => {
		vi.stubEnv("MAX_PYTHON_QUEUE", "1");
		const sm = new SessionManager({ createFs: async () => makeFakeFs(), maxConcurrentPython: 1 });
		const { release, operation } = await holdRuntime(sm);
		const session = await sm.getOrCreate(T, "queued", { python: true, javascript: false, network: false });
		const ac = new AbortController();
		const aborted = sm.execWithRuntimeThrottle(session, "echo aborted", { signal: ac.signal });
		ac.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		const replacement = sm.execWithRuntimeThrottle(session, "echo replacement");
		try {
			release();
			expect((await operation).stdout).toBe("released");
			expect((await replacement).stdout).toBe("replacement\n");
		} finally {
			release();
			await Promise.allSettled([operation, replacement]);
			await sm.shutdown();
		}
	});

	it("rejects with ERUNTIME_BUSY when queue is full", async () => {
		vi.stubEnv("MAX_PYTHON_QUEUE", "1");
		const sm = new SessionManager({ createFs: async () => makeFakeFs(), maxConcurrentPython: 1 });
		const { release, operation } = await holdRuntime(sm);
		const session = await sm.getOrCreate(T, "queued", { python: true, javascript: false, network: false });
		const queued = sm.execWithRuntimeThrottle(session, "echo queued");
		try {
			await expect(sm.execWithRuntimeThrottle(session, "echo overflow")).rejects.toBeInstanceOf(
				RuntimeBackpressureError,
			);
			release();
			expect((await operation).stdout).toBe("released");
			expect((await queued).stdout).toBe("queued\n");
		} finally {
			release();
			await Promise.allSettled([operation, queued]);
			await sm.shutdown();
		}
	});
});
