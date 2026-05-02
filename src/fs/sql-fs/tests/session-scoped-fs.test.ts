import { describe, expect, it, vi } from "vitest";
import { SessionScopedFs } from "../session-scoped-fs.js";
import type { IScriptTxFs } from "../sql-fs.js";

function makeMockInner(overrides?: Partial<IScriptTxFs>): IScriptTxFs {
	return {
		scriptScopeActive: false,
		scriptTxOpen: false,
		beginScriptScope: vi.fn(),
		endScriptScope: vi.fn(async () => {}),
		abortScriptScope: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		wasDirty: vi.fn(() => false),
		clearDirty: vi.fn(),
		bulkIngest: vi.fn(async () => {}),
		getAllPaths: vi.fn(() => []),
		writeFile: vi.fn(async () => {}),
		appendFile: vi.fn(async () => {}),
		readFile: vi.fn(async () => ""),
		readFileBuffer: vi.fn(async () => new Uint8Array(0)),
		exists: vi.fn(async () => false),
		stat: vi.fn(),
		lstat: vi.fn(),
		readdir: vi.fn(async () => []),
		mkdir: vi.fn(async () => {}),
		rm: vi.fn(async () => {}),
		cp: vi.fn(async () => {}),
		mv: vi.fn(async () => {}),
		chmod: vi.fn(async () => {}),
		utimes: vi.fn(async () => {}),
		resolvePath: vi.fn(() => "/"),
		symlink: vi.fn(async () => {}),
		link: vi.fn(async () => {}),
		readlink: vi.fn(async () => ""),
		realpath: vi.fn(async () => "/"),
		...overrides,
	} as unknown as IScriptTxFs;
}

describe("SessionScopedFs", () => {
	it("beginScope calls inner beginScriptScope", () => {
		const inner = makeMockInner();
		const ssf = new SessionScopedFs(inner);
		ssf.beginScope();
		expect(inner.beginScriptScope).toHaveBeenCalledOnce();
	});

	it("endScope calls inner endScriptScope", async () => {
		const inner = makeMockInner({ scriptScopeActive: true });
		const ssf = new SessionScopedFs(inner);
		await ssf.endScope();
		expect(inner.endScriptScope).toHaveBeenCalledOnce();
	});

	it("abortScope calls inner abortScriptScope", async () => {
		const inner = makeMockInner({ scriptScopeActive: true });
		const ssf = new SessionScopedFs(inner);
		await ssf.abortScope();
		expect(inner.abortScriptScope).toHaveBeenCalledOnce();
	});

	it("double beginScope is idempotent (skips when already active)", () => {
		const inner = makeMockInner({ scriptScopeActive: true });
		const ssf = new SessionScopedFs(inner);
		ssf.beginScope();
		expect(inner.beginScriptScope).not.toHaveBeenCalled();
	});

	it("double endScope is idempotent (skips when not active)", async () => {
		const inner = makeMockInner({ scriptScopeActive: false });
		const ssf = new SessionScopedFs(inner);
		await ssf.endScope();
		expect(inner.endScriptScope).not.toHaveBeenCalled();
	});

	it("double abortScope is idempotent (skips when not active)", async () => {
		const inner = makeMockInner({ scriptScopeActive: false });
		const ssf = new SessionScopedFs(inner);
		await ssf.abortScope();
		expect(inner.abortScriptScope).not.toHaveBeenCalled();
	});

	it("isActive reflects scriptScopeActive", () => {
		const inner = makeMockInner({ scriptScopeActive: true });
		const ssf = new SessionScopedFs(inner);
		expect(ssf.isActive).toBe(true);
	});

	it("hasTx reflects scriptTxOpen", () => {
		const inner = makeMockInner({ scriptTxOpen: true });
		const ssf = new SessionScopedFs(inner);
		expect(ssf.hasTx).toBe(true);
	});

	it("inner getter returns the wrapped IScriptTxFs", () => {
		const inner = makeMockInner();
		const ssf = new SessionScopedFs(inner);
		expect(ssf.inner).toBe(inner);
	});
});
