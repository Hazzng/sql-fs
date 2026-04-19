/**
 * Unit tests for SessionManager — US-074, US-075
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
