/**
 * Unit tests for createSandboxFs factory function.
 * US-053: createSandboxFs factory function
 */

import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxFs } from "./index.js";
import { SqlFs } from "./sql-fs.js";

// Mock the PostgresDialect so no real DB connection is made.
vi.mock("./dialects/postgres.js", () => ({
	PostgresDialect: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn().mockResolvedValue(undefined),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(),
		deleteDirent: vi.fn(),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(),
		gcOrphanBlobs: vi.fn(),
		loadAllPaths: vi.fn().mockResolvedValue([]),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	})),
}));

describe("createSandboxFs", () => {
	describe("memory backend", () => {
		it("returns InMemoryFs instance", async () => {
			const fs = await createSandboxFs("memory", "test-sandbox");
			expect(fs).toBeInstanceOf(InMemoryFs);
		});
	});

	describe("postgres backend", () => {
		beforeEach(() => {
			process.env.DATABASE_URL = "postgres://localhost/test";
		});

		afterEach(() => {
			process.env.DATABASE_URL = "";
		});

		it("returns SqlFs instance", async () => {
			const fs = await createSandboxFs("postgres", "test-sandbox");
			expect(fs).toBeInstanceOf(SqlFs);
		});

		it("throws if DATABASE_URL is not set", async () => {
			process.env.DATABASE_URL = "";
			await expect(createSandboxFs("postgres", "test-sandbox")).rejects.toThrow("DATABASE_URL");
		});
	});

	describe("unimplemented backends", () => {
		it.each(["mysql", "azure-sql", "azure-fileshare"] as const)(
			"throws 'not implemented' for %s backend",
			async (backend) => {
				await expect(createSandboxFs(backend, "test-sandbox")).rejects.toThrow("not implemented");
			},
		);
	});
});
