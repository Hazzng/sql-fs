/**
 * Unit tests for SqlFs.resolvePath (US-042)
 * Synchronous, pure path joining — no DB calls.
 */

import { describe, expect, it } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { SqlDialect } from "./types.js";

function makeFs(): SqlFs<unknown> {
	const dialect = {
		connect: async () => {},
		disconnect: async () => {},
		transaction: async <T>(_fn: (tx: unknown) => Promise<T>) => _fn({}),
		setSandboxContext: async () => {},
		createSandbox: async () => ({ rootInodeId: 1n }),
		deleteSandbox: async () => {},
		createInode: async () => 1n,
		getInode: async () => null,
		updateInode: async () => {},
		deleteInode: async () => {},
		incrementNlink: async () => {},
		decrementNlink: async () => 0,
		insertDirent: async () => {},
		upsertDirent: async () => null,
		deleteDirent: async () => 1n,
		listDirents: async () => [],
		moveDirent: async () => {},
		upsertBlob: async () => {},
		getBlob: async () => null,
		gcOrphanBlobs: async () => 0,
		loadAllPaths: async () => [],
		loadSubtreeInodes: async () => [],
		bulkIngest: async () => {},
		resolvePath: async () => 1n,
	} as unknown as SqlDialect<unknown>;

	return new SqlFs({ sandboxId: "test", dialect });
}

describe("SqlFs.resolvePath", () => {
	it("resolves relative path against base", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/home/user", "project/src")).toBe("/home/user/project/src");
	});

	it("absolute path overrides base", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/home/user", "/tmp")).toBe("/tmp");
	});

	it("handles . components in relative path", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/home/user", "./project")).toBe("/home/user/project");
	});

	it("handles .. components in relative path", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/home/user", "../other")).toBe("/home/other");
	});

	it("handles . components in absolute path", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/anywhere", "/home/./user")).toBe("/home/user");
	});

	it("handles .. components in absolute path", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/anywhere", "/home/user/../other")).toBe("/home/other");
	});

	it("resolves relative path when base is root", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/", "tmp")).toBe("/tmp");
	});

	it("returns / for empty path components resolving to root", () => {
		const fs = makeFs();
		expect(fs.resolvePath("/home/user", "../..")).toBe("/");
	});
});
