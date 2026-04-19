/**
 * Unit tests for SessionManager — US-074, US-075, US-076
 */

import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";

function makeCreateFs(impl?: () => Promise<IFileSystem>) {
	return vi.fn((_backend: string, _sandboxId: string): Promise<IFileSystem> => {
		if (impl) return impl();
		return Promise.resolve(new InMemoryFs());
	});
}

describe("SessionManager.getOrCreate", () => {
	it("first getOrCreate creates a new session, second call reuses it", async () => {
		const createFs = makeCreateFs();
		const sm = new SessionManager({ backend: "memory", createFs });

		const s1 = await sm.getOrCreate("sandbox-1");
		const s2 = await sm.getOrCreate("sandbox-1");

		expect(s1).toBe(s2);
		expect(createFs).toHaveBeenCalledTimes(1);
	});

	it("two concurrent getOrCreate for same sandboxId create exactly one session", async () => {
		let resolveFsCreation!: (fs: IFileSystem) => void;
		const fsPromise = new Promise<IFileSystem>((resolve) => {
			resolveFsCreation = resolve;
		});

		const createFs = vi.fn((_backend: string, _sandboxId: string) => fsPromise);

		const sm = new SessionManager({ backend: "memory", createFs });

		// Start both concurrently before the first resolves
		const p1 = sm.getOrCreate("sandbox-a");
		const p2 = sm.getOrCreate("sandbox-a");

		// Resolve the underlying fs creation
		resolveFsCreation(new InMemoryFs());

		const [s1, s2] = await Promise.all([p1, p2]);

		expect(s1).toBe(s2);
		expect(createFs).toHaveBeenCalledTimes(1);
	});

	it("different sandboxIds get independent sessions", async () => {
		const createFs = makeCreateFs();
		const sm = new SessionManager({ backend: "memory", createFs });

		const s1 = await sm.getOrCreate("sandbox-x");
		const s2 = await sm.getOrCreate("sandbox-y");

		expect(s1).not.toBe(s2);
		expect(createFs).toHaveBeenCalledTimes(2);
	});
});

describe("SessionManager.withSession", () => {
	it("two concurrent withSession calls execute sequentially (not in parallel)", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs() });

		const executionOrder: string[] = [];
		let resolveFirst!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		let releaseFirst!: () => void;
		const firstBlocker = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		// First call: signals it started, then waits for the blocker
		const call1 = sm.withSession("sandbox-seq", async () => {
			executionOrder.push("call1-start");
			resolveFirst();
			await firstBlocker;
			executionOrder.push("call1-end");
		});

		// Wait for call1 to start, then launch call2
		await firstStarted;

		const call2 = sm.withSession("sandbox-seq", async () => {
			executionOrder.push("call2-start");
			executionOrder.push("call2-end");
		});

		// Release call1 and wait for both to finish
		releaseFirst();
		await Promise.all([call1, call2]);

		expect(executionOrder).toEqual(["call1-start", "call1-end", "call2-start", "call2-end"]);
	});

	it("withSession increments and decrements inFlight", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs() });

		let inFlightDuringExecution = -1;
		await sm.withSession("sandbox-if", async (session) => {
			inFlightDuringExecution = session.inFlight;
		});

		const session = await sm.getOrCreate("sandbox-if");
		expect(inFlightDuringExecution).toBe(1);
		expect(session.inFlight).toBe(0);
	});
});

describe("SessionManager pathCache memory budget (US-075a)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("under-budget session stays resident after operations", async () => {
		vi.useFakeTimers();
		// Very large budget and very long idle — session should not be evicted
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeCreateFs(),
			idleMs: 1_000_000,
			pathCacheMaxBytes: 100 * 1024 * 1024,
		});
		sm.startReaper(2000);

		await sm.getOrCreate("sandbox-underbudget");
		expect(sm.getSession("sandbox-underbudget")).toBeDefined();

		// Reaper fires multiple times — session is under-budget and not idle
		vi.advanceTimersByTime(10_000);

		expect(sm.getSession("sandbox-underbudget")).toBeDefined();

		sm.stopReaper();
	});

	it("over-budget session is evicted when idle (inFlight=0) regardless of idleMs", async () => {
		vi.useFakeTimers();
		// pathCacheMaxBytes=1 means any non-empty pathCache is immediately over-budget
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeCreateFs(),
			idleMs: 1_000_000,
			pathCacheMaxBytes: 1,
		});
		sm.startReaper(2000);

		await sm.getOrCreate("sandbox-overbudget");
		expect(sm.getSession("sandbox-overbudget")).toBeDefined();

		// Reaper fires at 2000ms — session is over-budget and inFlight=0, evict regardless of idle timeout
		vi.advanceTimersByTime(3000);

		expect(sm.getSession("sandbox-overbudget")).toBeUndefined();

		sm.stopReaper();
	});
});

describe("SessionManager.destroy (US-076)", () => {
	it("destroy removes session from Map and calls destroySandbox", async () => {
		const destroySandboxFn = vi.fn().mockResolvedValue(undefined);
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), destroySandboxFn });

		await sm.getOrCreate("sandbox-destroy-basic");
		expect(sm.getSession("sandbox-destroy-basic")).toBeDefined();

		const result = await sm.destroy("sandbox-destroy-basic");

		expect(result).toBe(true);
		expect(sm.getSession("sandbox-destroy-basic")).toBeUndefined();
		expect(destroySandboxFn).toHaveBeenCalledWith("memory", "sandbox-destroy-basic");
	});

	it("destroy calls destroySandbox even when session is not in pool", async () => {
		const destroySandboxFn = vi.fn().mockResolvedValue(undefined);
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), destroySandboxFn });

		const result = await sm.destroy("sandbox-never-created");

		expect(result).toBe(false);
		expect(destroySandboxFn).toHaveBeenCalledWith("memory", "sandbox-never-created");
	});

	it("destroy waits for in-flight work before calling destroySandbox", async () => {
		const destroySandboxFn = vi.fn().mockResolvedValue(undefined);
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), destroySandboxFn });

		let releaseWork!: () => void;
		let workStartedResolve!: () => void;
		const workStarted = new Promise<void>((resolve) => {
			workStartedResolve = resolve;
		});
		const workBlocker = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});

		// Start a withSession that blocks inside the mutex
		const workPromise = sm.withSession("sandbox-destroy-wait", async () => {
			workStartedResolve();
			await workBlocker;
		});

		// Wait for the work to acquire the mutex
		await workStarted;

		// Destroy is called while work is in-flight
		const destroyPromise = sm.destroy("sandbox-destroy-wait");

		// destroySandbox should not have been called yet — destroy is waiting on the mutex
		expect(destroySandboxFn).not.toHaveBeenCalled();

		// Release the in-flight work, which frees the mutex so destroy can proceed
		releaseWork();
		await Promise.all([workPromise, destroyPromise]);

		expect(destroySandboxFn).toHaveBeenCalledWith("memory", "sandbox-destroy-wait");
		expect(sm.getSession("sandbox-destroy-wait")).toBeUndefined();
	});

	it("request arriving during destroy is rejected with error", async () => {
		const destroySandboxFn = vi.fn().mockResolvedValue(undefined);
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), destroySandboxFn });

		let releaseWork!: () => void;
		let workStartedResolve!: () => void;
		const workStarted = new Promise<void>((resolve) => {
			workStartedResolve = resolve;
		});
		const workBlocker = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});

		// Start a long-running withSession that holds the mutex
		const workPromise = sm.withSession("sandbox-reject-destroy", async () => {
			workStartedResolve();
			await workBlocker;
		});

		await workStarted;

		// Call destroy — marks state='closing' immediately (before queuing in mutex)
		const destroyPromise = sm.destroy("sandbox-reject-destroy");

		// New request arriving while destroy is pending: state='closing' → fail fast
		await expect(sm.withSession("sandbox-reject-destroy", async () => {})).rejects.toThrow("ESESSIONCLOSING");

		// Finish blocked work so destroy can complete
		releaseWork();
		await Promise.all([workPromise, destroyPromise]);
	});

	it("concurrent destroy calls are idempotent — destroySandbox called exactly once", async () => {
		const destroySandboxFn = vi.fn().mockResolvedValue(undefined);
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), destroySandboxFn });

		await sm.getOrCreate("sandbox-idem-destroy");

		await Promise.all([sm.destroy("sandbox-idem-destroy"), sm.destroy("sandbox-idem-destroy")]);

		expect(destroySandboxFn).toHaveBeenCalledTimes(1);
	});
});

describe("SessionManager idle eviction (US-075)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("session idle longer than idleMs with inFlight=0 is evicted from Map", async () => {
		vi.useFakeTimers();
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), idleMs: 1000 });
		// Reaper runs every 2000ms
		sm.startReaper(2000);

		await sm.getOrCreate("sandbox-idle");
		expect(sm.getSession("sandbox-idle")).toBeDefined();

		// Advance 3000ms — reaper fires at 2000ms; lastUsed=0, now=2000 → 2000 > 1000 → evict
		vi.advanceTimersByTime(3000);

		expect(sm.getSession("sandbox-idle")).toBeUndefined();

		sm.stopReaper();
	});

	it("busy session (inFlight > 0) past idle threshold is NOT evicted", async () => {
		vi.useFakeTimers();
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), idleMs: 1000 });
		sm.startReaper(2000);

		const session = await sm.getOrCreate("sandbox-busy");
		// Simulate an active in-flight operation
		session.inFlight = 1;

		// Advance past idle threshold — reaper fires at 2000ms but inFlight=1 so skip
		vi.advanceTimersByTime(3000);

		expect(sm.getSession("sandbox-busy")).toBeDefined();

		sm.stopReaper();
	});
});
