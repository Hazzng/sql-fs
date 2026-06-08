/**
 * Unit tests for session-level ownership of the Pyodide subprocess
 * (`session-manager.ts`). A fake PyodideSandbox is injected via
 * `createPyodideSandbox`; we assert its `dispose()` (the SIGKILL of the Deno
 * child) fires on EVERY teardown path: destroy, reaper, shutdown, failed-create.
 * No real Deno/Pyodide.
 */

import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PyodideSandbox } from "../../pyodide/manager.js";
import { SessionManager } from "../../session-manager.js";

const T = "tenantA";
const PYODIDE = { pythonRuntime: "pyodide", javascript: false, network: false } as const;

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

interface FakeSandbox {
	dispose: ReturnType<typeof vi.fn>;
	run: ReturnType<typeof vi.fn>;
}

function makeFakeSandbox(): FakeSandbox {
	return {
		dispose: vi.fn(() => Promise.resolve()),
		run: vi.fn(() => Promise.reject(new Error("not used in teardown tests"))),
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
	it("assigns session.pyodideSandbox only for the pyodide runtime", async () => {
		const { sm, sandbox } = makeManager();
		active = sm;
		const pyodideSession = await sm.getOrCreate(T, "pyo", PYODIDE);
		expect(pyodideSession.pyodideSandbox).toBe(sandbox as unknown as PyodideSandbox);

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
		await sm.getOrCreate(T, "pyo", PYODIDE);
		await sm.destroy(T, "pyo");
		expect(sandbox.dispose).toHaveBeenCalledTimes(1);
	});

	it("shutdown() disposes the pyodide child", async () => {
		const { sm, sandbox } = makeManager();
		await sm.getOrCreate(T, "pyo", PYODIDE);
		await sm.shutdown({ drainTimeoutMs: 500 });
		expect(sandbox.dispose).toHaveBeenCalledTimes(1);
	});

	it("the reaper disposes the pyodide child when a session goes idle", async () => {
		const { sm, sandbox } = makeManager(-1); // every session is immediately "idle"
		active = sm;
		await sm.getOrCreate(T, "pyo", PYODIDE);
		(sm as unknown as { runReaper(): void }).runReaper();
		await flush();
		await flush();
		expect(sandbox.dispose).toHaveBeenCalledTimes(1);
	});

	it("a failed session construction disposes the partially-built pyodide child", async () => {
		const fs = new InMemoryFs() as unknown as IFileSystem & { getAllPaths: () => string[] };
		const sandbox = makeFakeSandbox();
		const sm = new SessionManager({
			createFs: () => Promise.resolve(fs),
			createPyodideSandbox: () => sandbox as unknown as PyodideSandbox,
		});
		active = sm;
		// Blow up estimatePathCacheBytes, which runs AFTER the sandbox is built.
		fs.getAllPaths = () => {
			throw new Error("getAllPaths failed");
		};
		await expect(sm.getOrCreate(T, "pyo", PYODIDE)).rejects.toThrow("getAllPaths failed");
		expect(sandbox.dispose).toHaveBeenCalledTimes(1);
	});
});
