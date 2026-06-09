/**
 * Unit tests for session-level ownership of the Pyodide subprocess
 * (`session-manager.ts`). A fake PyodideSandbox is injected via
 * `createPyodideSandbox`. The manager is admitted LAZILY on the first python exec
 * (Phase 6 — admission must hold a pyodide semaphore slot), so each test runs a
 * `python3` exec first to materialize the worker, then asserts its `dispose()`
 * (the SIGKILL of the Deno child) fires on every teardown path (destroy, reaper,
 * shutdown), plus eviction-recovery re-admission. No real Deno/Pyodide.
 */

import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PyodideTimeoutError } from "../../pyodide/manager.js";
import type { PyodideSandbox } from "../../pyodide/manager.js";
import { SessionManager } from "../../session-manager.js";

const T = "tenantA";
const PYODIDE = { pythonRuntime: "pyodide", javascript: false, network: false } as const;

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Materialize the lazily-admitted pyodide manager by running a `--version` exec
 * through the throttle (admission happens post-semaphore inside
 * `execWithRuntimeThrottle`). `--version` short-circuits without invoking the
 * sandbox's `run`, so the injected fake is admitted but never executed.
 */
type SmSession = Parameters<SessionManager["execWithRuntimeThrottle"]>[0];
async function admitViaExec(sm: SessionManager, session: SmSession): Promise<void> {
	await sm.execWithRuntimeThrottle(session, "python3 --version");
}

interface FakeSandbox {
	dispose: ReturnType<typeof vi.fn>;
	run: ReturnType<typeof vi.fn>;
	state: string;
	disposed: boolean;
}

function makeFakeSandbox(): FakeSandbox {
	return {
		dispose: vi.fn(() => Promise.resolve()),
		run: vi.fn(() => Promise.reject(new Error("not used in teardown tests"))),
		state: "idle",
		disposed: false,
	};
}

/** A SessionManager wired with InMemoryFs + an injected fake sandbox. */
function makeManager(idleMs?: number): { sm: SessionManager; sandbox: FakeSandbox; fs: InMemoryFs } {
	const fs = new InMemoryFs();
	const sandbox = makeFakeSandbox();
	const sm = new SessionManager({
		createFs: () => Promise.resolve(fs as IFileSystem),
		createPyodideSandbox: () => sandbox as unknown as PyodideSandbox,
		idleMs,
	});
	return { sm, sandbox, fs };
}

let active: SessionManager | undefined;
afterEach(async () => {
	if (active) {
		await active.shutdown().catch(() => {});
		active = undefined;
	}
});

describe("session pyodide ownership", () => {
	it("admits session.pyodideSandbox lazily on first exec, only for the pyodide runtime", async () => {
		const { sm, sandbox } = makeManager();
		active = sm;
		const pyodideSession = await sm.getOrCreate(T, "pyo", PYODIDE);
		expect(pyodideSession.pyodideSandbox).toBeUndefined(); // lazy — not admitted at getOrCreate
		await admitViaExec(sm, pyodideSession);
		expect(pyodideSession.pyodideSandbox).toBe(sandbox as unknown as PyodideSandbox);

		// stdlib never admits a pyodide manager.
		const stdlibSession = await sm.getOrCreate(T, "std", {
			pythonRuntime: "stdlib",
			javascript: false,
			network: false,
		});
		expect(stdlibSession.pyodideSandbox).toBeUndefined();
	});

	it("registers working python3 + python commands for the pyodide runtime", async () => {
		const { sm } = makeManager();
		active = sm;
		const session = await sm.getOrCreate(T, "pyo", PYODIDE);
		// --version short-circuits in the command (no sandbox.run), so this proves
		// the custom command is registered + dispatched by Bash.
		const v3 = await session.bash.exec("python3 --version");
		expect(v3.stdout).toContain("Pyodide");
		expect(v3.exitCode).toBe(0);
		const v = await session.bash.exec("python --version");
		expect(v.stdout).toContain("Pyodide");
	});

	it("does NOT register python3 for a null-runtime sandbox", async () => {
		const { sm } = makeManager();
		active = sm;
		const session = await sm.getOrCreate(T, "none", { pythonRuntime: null, javascript: false, network: false });
		const res = await session.bash.exec("python3 --version");
		expect(res.exitCode).not.toBe(0); // command-not-found, not our handler
	});

	it("destroy() disposes the pyodide child", async () => {
		const { sm, sandbox } = makeManager();
		active = sm;
		const session = await sm.getOrCreate(T, "pyo", PYODIDE);
		await admitViaExec(sm, session); // lazily admit the manager
		await sm.destroy(T, "pyo");
		expect(sandbox.dispose).toHaveBeenCalledTimes(1);
	});

	it("shutdown() disposes the pyodide child", async () => {
		const { sm, sandbox } = makeManager();
		const session = await sm.getOrCreate(T, "pyo", PYODIDE);
		await admitViaExec(sm, session);
		await sm.shutdown({ drainTimeoutMs: 500 });
		expect(sandbox.dispose).toHaveBeenCalledTimes(1);
	});

	it("the reaper disposes the pyodide child when a session goes idle", async () => {
		const { sm, sandbox } = makeManager(-1); // every session is immediately "idle"
		active = sm;
		const session = await sm.getOrCreate(T, "pyo", PYODIDE);
		await admitViaExec(sm, session);
		(sm as unknown as { runReaper(): void }).runReaper();
		await flush();
		await flush();
		expect(sandbox.dispose).toHaveBeenCalledTimes(1);
	});

	it("re-admits a fresh manager when the session's worker was evicted (cold-start on next exec)", async () => {
		// A residency eviction / idle-kill disposes the session's worker. The next
		// pyodide exec must re-admit a fresh manager (the evicted session cold-starts).
		const fs = new InMemoryFs();
		const created: FakeSandbox[] = [];
		const sm = new SessionManager({
			createFs: () => Promise.resolve(fs as IFileSystem),
			createPyodideSandbox: () => {
				const s = makeFakeSandbox();
				created.push(s);
				return s as unknown as PyodideSandbox;
			},
		});
		active = sm;
		const session = await sm.getOrCreate(T, "pyo", PYODIDE);
		expect(created).toHaveLength(0); // lazy — nothing admitted at getOrCreate
		// Stub bash.exec so the throttle path runs without invoking the fake's run().
		// biome-ignore lint/suspicious/noExplicitAny: overwrite readonly method for test control
		(session.bash as any).exec = async () => ({ stdout: "", stderr: "", exitCode: 0, env: {} });

		await sm.execWithRuntimeThrottle(session, "python3 -c '1'"); // first exec admits W1
		expect(created).toHaveLength(1);
		expect(session.pyodideSandbox).toBe(created[0] as unknown as PyodideSandbox);

		// Simulate a residency eviction of W1 (its child SIGKILLed, manager disposed).
		created[0]!.disposed = true;

		await sm.execWithRuntimeThrottle(session, "python3 -c '2'"); // re-admits W2

		expect(created).toHaveLength(2); // W2 re-admitted on the next exec
		expect(session.pyodideSandbox).toBe(created[1] as unknown as PyodideSandbox);
		expect(session.pyodideSandbox?.disposed).toBe(false);
	});

	it("surfaces an internal runtime timeout as a fatal EPYODIDE_TIMEOUT throw (review #4)", async () => {
		const { sm, sandbox } = makeManager();
		active = sm;
		const session = await sm.getOrCreate(T, "pyo", PYODIDE);
		// The manager's internal runtime timeout: run() rejects with PyodideTimeoutError.
		// just-bash flattens that into a non-zero ExecResult; the command tags the
		// per-exec context and execWithRuntimeThrottle re-raises it as a fatal throw so
		// the route layer can map it to a consistent timeout response.
		sandbox.run = vi.fn(() => Promise.reject(new PyodideTimeoutError(25)));
		await expect(sm.execWithRuntimeThrottle(session, "python3 -c '1'")).rejects.toMatchObject({
			code: "EPYODIDE_TIMEOUT",
		});
	});

	it("a getOrCreate failure builds no pyodide manager to dispose (admission is lazy)", async () => {
		const fs = new InMemoryFs() as unknown as IFileSystem & { getAllPaths: () => string[] };
		const sandbox = makeFakeSandbox();
		const sm = new SessionManager({
			createFs: () => Promise.resolve(fs),
			createPyodideSandbox: () => sandbox as unknown as PyodideSandbox,
		});
		active = sm;
		// Blow up estimatePathCacheBytes, which runs during session construction.
		fs.getAllPaths = () => {
			throw new Error("getAllPaths failed");
		};
		await expect(sm.getOrCreate(T, "pyo", PYODIDE)).rejects.toThrow("getAllPaths failed");
		// No manager is admitted at getOrCreate (lazy), so the factory was never
		// called and there is no partial child to dispose.
		expect(sandbox.dispose).not.toHaveBeenCalled();
	});
});
