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

describe("SessionManager.withExistingSession (US-076a)", () => {
	it("throws ENOENT for non-existent sandbox", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs() });
		await expect(sm.withExistingSession("nonexistent", async () => {})).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("succeeds for existing sandbox", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs() });
		await sm.getOrCreate("test-existing");
		const result = await sm.withExistingSession("test-existing", async (session) => {
			return session.fs.exists("/");
		});
		expect(result).toBe(true);
	});

	it("throws ENOENT after destroy completes", async () => {
		const destroySandboxFn = vi.fn().mockResolvedValue(undefined);
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), destroySandboxFn });
		await sm.getOrCreate("closing-test");
		await sm.destroy("closing-test");
		await expect(sm.withExistingSession("closing-test", async () => {})).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("increments and decrements inFlight", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs() });
		await sm.getOrCreate("sandbox-existing-if");
		let inFlightDuringExecution = -1;
		await sm.withExistingSession("sandbox-existing-if", async (session) => {
			inFlightDuringExecution = session.inFlight;
		});
		const session = sm.getSession("sandbox-existing-if");
		expect(inFlightDuringExecution).toBe(1);
		expect(session?.inFlight).toBe(0);
	});
});

describe("SessionManager runtime options + Python semaphore (US-080a)", () => {
	type ExecImpl = (
		script: string,
	) => Promise<{ stdout: string; stderr: string; exitCode: number; env: Record<string, string> }>;

	// Replaces `session.bash.exec` with a controllable fake so tests don't actually spawn WASM.
	function stubBashExec(session: { bash: unknown }, impl: ExecImpl): void {
		// biome-ignore lint/suspicious/noExplicitAny: deliberately overwriting a readonly method for test control
		(session.bash as any).exec = impl;
	}

	it("warm session ignores subsequent runtimeOptions (cache-hit path)", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs() });
		const first = await sm.getOrCreate("sandbox-warm", { python: true, javascript: false });
		const second = await sm.getOrCreate("sandbox-warm", { python: false, javascript: true });
		expect(second).toBe(first);
		expect(second.runtimeOptions).toEqual({ python: true, javascript: false });
	});

	it("non-Python script bypasses semaphore entirely", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentPython: 1 });
		const session = await sm.getOrCreate("sandbox-no-py", { python: true, javascript: false });
		stubBashExec(session, async () => ({ stdout: "hi", stderr: "", exitCode: 0, env: {} }));

		await sm.execWithRuntimeThrottle(session, "echo hi");
		// If the script had consumed a slot, pythonInFlight would have been incremented
		// to 1. Probing: kick off a Python exec and ensure it is not stuck on the semaphore
		// (which would be the case if the echo above had wrongfully consumed the only slot).
		stubBashExec(session, async () => ({ stdout: "2", stderr: "", exitCode: 0, env: {} }));
		const result = await sm.execWithRuntimeThrottle(session, "python3 -c 'print(1+1)'");
		expect(result.stdout).toBe("2");
	});

	it("session without python runtime does NOT throttle even if script mentions python3", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentPython: 1 });
		const session = await sm.getOrCreate("sandbox-no-runtime");
		let execCount = 0;
		stubBashExec(session, async () => {
			execCount++;
			return { stdout: "", stderr: "", exitCode: 127, env: {} };
		});

		// Kick off 3 "python3" scripts in parallel with a 1-slot cap. Since the runtime
		// is NOT enabled, the semaphore must not gate them — all run concurrently.
		await Promise.all([
			sm.execWithRuntimeThrottle(session, "python3 -c 'x'"),
			sm.execWithRuntimeThrottle(session, "python3 -c 'y'"),
			sm.execWithRuntimeThrottle(session, "python3 -c 'z'"),
		]);
		expect(execCount).toBe(3);
	});

	it("regex does not match mypython_script or python-config (word boundary)", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentPython: 1 });
		const session = await sm.getOrCreate("sandbox-regex", { python: true, javascript: false });

		let running = 0;
		let peak = 0;
		stubBashExec(session, async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		// These scripts should NOT match the python-word-boundary regex and should run in parallel,
		// even though the concurrency cap is 1.
		await Promise.all([
			sm.execWithRuntimeThrottle(session, "echo mypython_script"),
			sm.execWithRuntimeThrottle(session, "echo python-config"),
			sm.execWithRuntimeThrottle(session, "echo pythonic"),
		]);
		expect(peak).toBeGreaterThan(1);
	});

	it("semaphore allows up to N concurrent Python executions, queues the (N+1)th until a slot frees", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentPython: 2 });
		const session = await sm.getOrCreate("sandbox-sem", { python: true, javascript: false });

		const releasers: Array<() => void> = [];
		let started = 0;
		stubBashExec(session, async () => {
			started++;
			await new Promise<void>((resolve) => {
				releasers.push(resolve);
			});
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		const p1 = sm.execWithRuntimeThrottle(session, "python3 -c 'a'");
		const p2 = sm.execWithRuntimeThrottle(session, "python3 -c 'b'");
		const p3 = sm.execWithRuntimeThrottle(session, "python3 -c 'c'");

		// Give the event loop a chance to start the first two
		await new Promise((r) => setTimeout(r, 10));
		expect(started).toBe(2);

		// Release the first slot — the third script should now start
		releasers[0]?.();
		await new Promise((r) => setTimeout(r, 10));
		expect(started).toBe(3);

		// Release the rest
		releasers[1]?.();
		releasers[2]?.();
		await Promise.all([p1, p2, p3]);
	});

	it("slot is released even when bash.exec throws", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentPython: 1 });
		const session = await sm.getOrCreate("sandbox-throw", { python: true, javascript: false });

		let execCount = 0;
		stubBashExec(session, async () => {
			execCount++;
			if (execCount === 1) throw new Error("boom");
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		await expect(sm.execWithRuntimeThrottle(session, "python3 -c '1'")).rejects.toThrow("boom");

		// If the slot was not released, this second call would hang forever because the
		// cap is 1. Add a timeout to fail fast if so.
		const second = sm.execWithRuntimeThrottle(session, "python3 -c '2'");
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("slot not released")), 500));
		await expect(Promise.race([second, timeout])).resolves.toMatchObject({ exitCode: 0 });
	});
});

describe("SessionManager JavaScript semaphore (MAX_CONCURRENT_JS)", () => {
	type ExecImpl = (
		script: string,
	) => Promise<{ stdout: string; stderr: string; exitCode: number; env: Record<string, string> }>;

	function stubBashExec(session: { bash: unknown }, impl: ExecImpl): void {
		// biome-ignore lint/suspicious/noExplicitAny: deliberately overwriting a readonly method for test control
		(session.bash as any).exec = impl;
	}

	it("session without javascript runtime does NOT throttle even if script mentions js-exec/node", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentJs: 1 });
		const session = await sm.getOrCreate("sandbox-js-off");
		let execCount = 0;
		stubBashExec(session, async () => {
			execCount++;
			return { stdout: "", stderr: "", exitCode: 127, env: {} };
		});

		await Promise.all([
			sm.execWithRuntimeThrottle(session, "js-exec -c 'a'"),
			sm.execWithRuntimeThrottle(session, "node -e 'b'"),
			sm.execWithRuntimeThrottle(session, "js-exec script.ts"),
		]);
		expect(execCount).toBe(3);
	});

	it("JS regex does not match mynode/nodejs_tool/js-exec-helper etc (word boundary)", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentJs: 1 });
		const session = await sm.getOrCreate("sandbox-js-regex", { python: false, javascript: true });

		let running = 0;
		let peak = 0;
		stubBashExec(session, async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		await Promise.all([
			sm.execWithRuntimeThrottle(session, "echo mynode"),
			sm.execWithRuntimeThrottle(session, "echo nodejs_tool"),
			sm.execWithRuntimeThrottle(session, "echo myjs-exec-helper"),
		]);
		expect(peak).toBeGreaterThan(1);
	});

	it("12 parallel js-exec scripts with cap=4 run in 3 batches of 4", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentJs: 4 });
		const session = await sm.getOrCreate("sandbox-js-12", { python: false, javascript: true });

		let running = 0;
		let peak = 0;
		const batches: number[] = [];
		stubBashExec(session, async () => {
			running++;
			peak = Math.max(peak, running);
			batches.push(running);
			await new Promise((r) => setTimeout(r, 30));
			running--;
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		const all = Array.from({ length: 12 }, (_, i) =>
			sm.execWithRuntimeThrottle(session, `js-exec -c 'console.log(${i})'`),
		);
		await Promise.all(all);

		expect(peak).toBe(4);
		expect(batches.length).toBe(12);
	});

	it("semaphore allows up to N concurrent JS executions, queues the (N+1)th until a slot frees", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentJs: 2 });
		const session = await sm.getOrCreate("sandbox-js-sem", { python: false, javascript: true });

		const releasers: Array<() => void> = [];
		let started = 0;
		stubBashExec(session, async () => {
			started++;
			await new Promise<void>((resolve) => {
				releasers.push(resolve);
			});
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		const p1 = sm.execWithRuntimeThrottle(session, "js-exec -c 'a'");
		const p2 = sm.execWithRuntimeThrottle(session, "node script.js");
		const p3 = sm.execWithRuntimeThrottle(session, "js-exec -c 'c'");

		await new Promise((r) => setTimeout(r, 10));
		expect(started).toBe(2);

		releasers[0]?.();
		await new Promise((r) => setTimeout(r, 10));
		expect(started).toBe(3);

		releasers[1]?.();
		releasers[2]?.();
		await Promise.all([p1, p2, p3]);
	});

	it("JS slot is released even when bash.exec throws", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), maxConcurrentJs: 1 });
		const session = await sm.getOrCreate("sandbox-js-throw", { python: false, javascript: true });

		let execCount = 0;
		stubBashExec(session, async () => {
			execCount++;
			if (execCount === 1) throw new Error("boom");
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		await expect(sm.execWithRuntimeThrottle(session, "js-exec -c '1'")).rejects.toThrow("boom");

		const second = sm.execWithRuntimeThrottle(session, "js-exec -c '2'");
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("slot not released")), 500));
		await expect(Promise.race([second, timeout])).resolves.toMatchObject({ exitCode: 0 });
	});
});

describe("SessionManager combined python + js semaphores", () => {
	type ExecImpl = (
		script: string,
	) => Promise<{ stdout: string; stderr: string; exitCode: number; env: Record<string, string> }>;

	function stubBashExec(session: { bash: unknown }, impl: ExecImpl): void {
		// biome-ignore lint/suspicious/noExplicitAny: deliberately overwriting a readonly method for test control
		(session.bash as any).exec = impl;
	}

	it("combined-runtime script eventually holds both slots; other callers on each semaphore queue correctly", async () => {
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeCreateFs(),
			maxConcurrentPython: 1,
			maxConcurrentJs: 1,
		});
		const session = await sm.getOrCreate("sandbox-both", { python: true, javascript: true });

		const releasers: Array<() => void> = [];
		stubBashExec(session, async () => {
			await new Promise<void>((resolve) => {
				releasers.push(resolve);
			});
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		// Launch a combined script first — it acquires python, then js.
		const combined = sm.execWithRuntimeThrottle(session, "python3 x.py && js-exec y.ts");
		await new Promise((r) => setTimeout(r, 10));
		// Combined is now running with both slots held.
		expect(releasers.length).toBe(1);

		// While combined holds both slots, a python-only script must queue.
		const pyOnly = sm.execWithRuntimeThrottle(session, "python3 -c 'p'");
		// And a js-only script must also queue.
		const jsOnly = sm.execWithRuntimeThrottle(session, "js-exec -c 'j'");
		await new Promise((r) => setTimeout(r, 10));
		expect(releasers.length).toBe(1); // neither has started

		// Release combined → both slots free up. Next two should now run concurrently.
		releasers[0]?.();
		await new Promise((r) => setTimeout(r, 10));
		expect(releasers.length).toBe(3); // combined's + py's + js's

		releasers[1]?.();
		releasers[2]?.();
		await Promise.all([combined, pyOnly, jsOnly]);
	});

	it("acquisition order python→js avoids deadlock when two scripts each need both slots", async () => {
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeCreateFs(),
			maxConcurrentPython: 1,
			maxConcurrentJs: 1,
		});
		const session = await sm.getOrCreate("sandbox-deadlock", { python: true, javascript: true });

		let peak = 0;
		let running = 0;
		stubBashExec(session, async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 15));
			running--;
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		// Two scripts, each needing BOTH slots — with the fixed acquisition order
		// (python first, then js), they serialize cleanly. If acquisition order weren't
		// fixed, these could deadlock if one acquired py and the other acquired js.
		await Promise.all([
			sm.execWithRuntimeThrottle(session, "python3 x.py && js-exec y.ts"),
			sm.execWithRuntimeThrottle(session, "python3 a.py && node b.js"),
		]);

		expect(peak).toBe(1); // never run concurrently since both slots are 1-capped
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
