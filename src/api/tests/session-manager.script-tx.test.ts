import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { SessionScopedFs } from "../../fs/sql-fs/session-scoped-fs.js";
import type { IScriptTxFs } from "../../fs/sql-fs/sql-fs.js";
import { SessionManager } from "../session-manager.js";

const T = "default";

function makeCreateFs(impl?: () => Promise<IFileSystem>) {
	return vi.fn((_tenantId: string, _sandboxId: string): Promise<IFileSystem> => {
		if (impl) return impl();
		return Promise.resolve(new InMemoryFs());
	});
}

type ExecImpl = (
	script: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number; env: Record<string, string> }>;

function stubBashExec(session: { bash: unknown }, impl: ExecImpl): void {
	// biome-ignore lint/suspicious/noExplicitAny: deliberately overwriting a readonly method for test control
	(session.bash as any).exec = impl;
}

describe("asScriptTxFs guard", () => {
	it("getOrCreate with InMemoryFs: session.scriptTx is undefined", async () => {
		const sm = new SessionManager({ createFs: makeCreateFs() });
		const session = await sm.getOrCreate(T, "mem-sandbox");
		expect(session.scriptTx).toBeUndefined();
	});

	it("getOrCreate with IScriptTxFs: session.scriptTx is a SessionScopedFs", async () => {
		const base = new InMemoryFs();
		const mockFs = {
			getAllPaths: () => base.getAllPaths(),
			reload: vi.fn(async () => {}),
			wasDirty: vi.fn(() => false),
			clearDirty: vi.fn(),
			bulkIngest: vi.fn(async () => {}),
			beginScriptScope: vi.fn(),
			endScriptScope: vi.fn(async () => {}),
			abortScriptScope: vi.fn(async () => {}),
			scriptScopeActive: false,
			scriptTxOpen: false,
		} as unknown as IScriptTxFs;

		const sm = new SessionManager({
			createFs: vi.fn(async () => mockFs),
		});
		const session = await sm.getOrCreate(T, "sql-sandbox");
		expect(session.scriptTx).toBeInstanceOf(SessionScopedFs);
	});
});

describe("execWithRuntimeThrottle script-tx wrapping", () => {
	it("calls beginScope before bash.exec and endScope after success", async () => {
		const beginScope = vi.fn();
		const endScope = vi.fn(async () => {});
		const abortScope = vi.fn(async () => {});

		const sm = new SessionManager({ createFs: makeCreateFs() });
		const session = await sm.getOrCreate(T, "wrap-ok");
		stubBashExec(session, async () => ({ stdout: "ok", stderr: "", exitCode: 0, env: {} }));

		const mockScriptTx = {
			beginScope,
			endScope,
			abortScope,
			isActive: false,
			hasTx: false,
		} as unknown as SessionScopedFs;
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(session as any).scriptTx = mockScriptTx;

		const result = await sm.execWithRuntimeThrottle(session, "echo hi");
		expect(result.stdout).toBe("ok");
		expect(beginScope).toHaveBeenCalledOnce();
		expect(endScope).toHaveBeenCalledOnce();
		expect(abortScope).not.toHaveBeenCalled();
	});

	it("calls abortScope on bash.exec exception", async () => {
		const beginScope = vi.fn();
		const endScope = vi.fn(async () => {});
		const abortScope = vi.fn(async () => {});

		const sm = new SessionManager({ createFs: makeCreateFs() });
		const session = await sm.getOrCreate(T, "wrap-err");
		stubBashExec(session, async () => {
			throw new Error("exec failed");
		});

		const mockScriptTx = {
			beginScope,
			endScope,
			abortScope,
			isActive: false,
			hasTx: false,
		} as unknown as SessionScopedFs;
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(session as any).scriptTx = mockScriptTx;

		await expect(sm.execWithRuntimeThrottle(session, "bad cmd")).rejects.toThrow("exec failed");
		expect(beginScope).toHaveBeenCalledOnce();
		expect(abortScope).toHaveBeenCalledOnce();
		expect(endScope).not.toHaveBeenCalled();
	});

	it("non-zero exit code calls endScope (commit, not abort)", async () => {
		const beginScope = vi.fn();
		const endScope = vi.fn(async () => {});
		const abortScope = vi.fn(async () => {});

		const sm = new SessionManager({ createFs: makeCreateFs() });
		const session = await sm.getOrCreate(T, "wrap-exit1");
		stubBashExec(session, async () => ({ stdout: "", stderr: "err", exitCode: 1, env: {} }));

		const mockScriptTx = {
			beginScope,
			endScope,
			abortScope,
			isActive: false,
			hasTx: false,
		} as unknown as SessionScopedFs;
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(session as any).scriptTx = mockScriptTx;

		const result = await sm.execWithRuntimeThrottle(session, "false");
		expect(result.exitCode).toBe(1);
		expect(endScope).toHaveBeenCalledOnce();
		expect(abortScope).not.toHaveBeenCalled();
	});

	it("when session.scriptTx is undefined, bash.exec called directly", async () => {
		const sm = new SessionManager({ createFs: makeCreateFs() });
		const session = await sm.getOrCreate(T, "wrap-mem");
		expect(session.scriptTx).toBeUndefined();

		stubBashExec(session, async () => ({ stdout: "direct", stderr: "", exitCode: 0, env: {} }));
		const result = await sm.execWithRuntimeThrottle(session, "echo direct");
		expect(result.stdout).toBe("direct");
	});

	it("Python semaphore still acquired/released around scope", async () => {
		const beginScope = vi.fn();
		const endScope = vi.fn(async () => {});
		const abortScope = vi.fn(async () => {});

		const sm = new SessionManager({ createFs: makeCreateFs(), maxConcurrentPython: 1 });
		const session = await sm.getOrCreate(T, "wrap-py", { python: true, javascript: false, network: false });
		stubBashExec(session, async () => ({ stdout: "py", stderr: "", exitCode: 0, env: {} }));

		const mockScriptTx = {
			beginScope,
			endScope,
			abortScope,
			isActive: false,
			hasTx: false,
		} as unknown as SessionScopedFs;
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(session as any).scriptTx = mockScriptTx;

		await sm.execWithRuntimeThrottle(session, "python3 -c 'print(1)'");
		expect(beginScope).toHaveBeenCalledOnce();
		expect(endScope).toHaveBeenCalledOnce();

		stubBashExec(session, async () => ({ stdout: "py2", stderr: "", exitCode: 0, env: {} }));
		const result = await sm.execWithRuntimeThrottle(session, "python3 -c 'print(2)'");
		expect(result.stdout).toBe("py2");
	});

	it("JS semaphore still acquired/released around scope", async () => {
		const beginScope = vi.fn();
		const endScope = vi.fn(async () => {});
		const abortScope = vi.fn(async () => {});

		const sm = new SessionManager({ createFs: makeCreateFs(), maxConcurrentJs: 1 });
		const session = await sm.getOrCreate(T, "wrap-js", { python: false, javascript: true, network: false });
		stubBashExec(session, async () => ({ stdout: "js", stderr: "", exitCode: 0, env: {} }));

		const mockScriptTx = {
			beginScope,
			endScope,
			abortScope,
			isActive: false,
			hasTx: false,
		} as unknown as SessionScopedFs;
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(session as any).scriptTx = mockScriptTx;

		await sm.execWithRuntimeThrottle(session, "js-exec -c 'a'");
		expect(beginScope).toHaveBeenCalledOnce();
		expect(endScope).toHaveBeenCalledOnce();

		stubBashExec(session, async () => ({ stdout: "js2", stderr: "", exitCode: 0, env: {} }));
		const result = await sm.execWithRuntimeThrottle(session, "js-exec -c 'b'");
		expect(result.stdout).toBe("js2");
	});
});
