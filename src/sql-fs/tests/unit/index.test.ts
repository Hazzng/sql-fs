/**
 * Unit tests for createSandboxFs factory function, loadBackendConfig, and destroySandbox.
 * US-053: createSandboxFs factory function
 * US-054: Environment variable configuration
 * US-055: destroySandbox
 */

import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { createSandboxFs, destroySandbox, loadBackendConfig } from "../../index.js";
import { SqlFs } from "../../sql-fs.js";

const constructed: string[] = [];

// Fake ioredis so role assertions never open a real socket.
vi.mock("ioredis", () => {
	class FakeRedis {
		constructor(_url: string, options: { connectionName?: string }) {
			constructed.push(options.connectionName ?? "unnamed");
		}
		on(): this {
			return this;
		}
		async quit(): Promise<"OK"> {
			return "OK";
		}
		disconnect(): void {}
	}
	return { Redis: FakeRedis };
});

beforeEach(() => {
	constructed.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

// Mock the PostgresDialect so no real DB connection is made.
vi.mock("../../dialects/postgres.js", () => ({
	PostgresDialect: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn().mockResolvedValue(undefined),
		setSandboxContextWithLock: vi.fn().mockResolvedValue(undefined),
		createSandbox: vi.fn().mockResolvedValue({ rootInodeId: 1n, createdAt: new Date().toISOString() }),
		deleteSandbox: vi.fn(),
		getSandboxEpoch: vi.fn().mockResolvedValue(0n),
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
		getBlobsForSandbox: vi.fn(async () => []),
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

		it("opens no data connection when lock-only (blob cache off, snapshot off)", async () => {
			// #167: REDIS_DATA_URL falls back to REDIS_URL inside getRedisClient,
			// so requesting the data client would always connect — the factory
			// must not request it when no data-plane feature is enabled.
			// Fresh module import: getRedisClient memoizes per role per process.
			vi.resetModules();
			vi.stubEnv("REDIS_URL", "redis://localhost:6379");
			vi.stubEnv("REDIS_DATA_URL", undefined);
			vi.stubEnv("REDIS_BLOB_CACHE_ENABLED", "false");
			vi.stubEnv("REDIS_PATH_SNAPSHOT_ENABLED", "false");
			vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
			const { createSandboxFs: freshCreateSandboxFs } = await import("../../index.js");
			// Fresh class identity: resetModules re-evaluates sql-fs.js, so the
			// static SqlFs binding no longer matches for instanceof.
			const { SqlFs: FreshSqlFs } = await import("../../sql-fs.js");
			const fs = await freshCreateSandboxFs("postgres", "lock-only-sandbox");
			expect(fs).toBeInstanceOf(FreshSqlFs);
			expect(constructed).toEqual(["sql-fs-control"]);
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

describe("loadBackendConfig", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		// Restore original env after each test
		process.env.FS_BACKEND = originalEnv.FS_BACKEND ?? "";
		process.env.DATABASE_URL = originalEnv.DATABASE_URL ?? "";
		process.env.FS_MOUNT_PATH = originalEnv.FS_MOUNT_PATH ?? "";
	});

	it("throws descriptive error if FS_BACKEND not set", () => {
		process.env.FS_BACKEND = "";
		expect(() => loadBackendConfig()).toThrow("FS_BACKEND");
	});

	it("returns correct config for postgres backend", () => {
		process.env.FS_BACKEND = "postgres";
		process.env.DATABASE_URL = "postgres://localhost/test";
		const config = loadBackendConfig();
		expect(config).toEqual({ backend: "postgres", databaseUrl: "postgres://localhost/test" });
	});

	it("returns correct config for mysql backend", () => {
		process.env.FS_BACKEND = "mysql";
		process.env.DATABASE_URL = "mysql://localhost/test";
		const config = loadBackendConfig();
		expect(config).toEqual({ backend: "mysql", databaseUrl: "mysql://localhost/test" });
	});

	it("returns correct config for azure-sql backend", () => {
		process.env.FS_BACKEND = "azure-sql";
		process.env.DATABASE_URL = "mssql://localhost/test";
		const config = loadBackendConfig();
		expect(config).toEqual({ backend: "azure-sql", databaseUrl: "mssql://localhost/test" });
	});

	it("returns correct config for azure-fileshare backend", () => {
		process.env.FS_BACKEND = "azure-fileshare";
		process.env.FS_MOUNT_PATH = "/mnt/share";
		const config = loadBackendConfig();
		expect(config).toEqual({ backend: "azure-fileshare", mountPath: "/mnt/share" });
	});

	it("returns correct config for memory backend", () => {
		process.env.FS_BACKEND = "memory";
		const config = loadBackendConfig();
		expect(config).toEqual({ backend: "memory" });
	});

	it("throws if DATABASE_URL missing for postgres", () => {
		process.env.FS_BACKEND = "postgres";
		process.env.DATABASE_URL = "";
		expect(() => loadBackendConfig()).toThrow("DATABASE_URL");
	});

	it("throws if DATABASE_URL missing for mysql", () => {
		process.env.FS_BACKEND = "mysql";
		process.env.DATABASE_URL = "";
		expect(() => loadBackendConfig()).toThrow("DATABASE_URL");
	});

	it("throws if DATABASE_URL missing for azure-sql", () => {
		process.env.FS_BACKEND = "azure-sql";
		process.env.DATABASE_URL = "";
		expect(() => loadBackendConfig()).toThrow("DATABASE_URL");
	});

	it("throws if FS_MOUNT_PATH missing for azure-fileshare", () => {
		process.env.FS_BACKEND = "azure-fileshare";
		process.env.FS_MOUNT_PATH = "";
		expect(() => loadBackendConfig()).toThrow("FS_MOUNT_PATH");
	});
});

describe("destroySandbox", () => {
	describe("memory backend", () => {
		it("returns without error", async () => {
			await expect(destroySandbox("memory", "sandbox-123")).resolves.toBeUndefined();
		});
	});

	describe("postgres backend", () => {
		beforeEach(() => {
			process.env.DATABASE_URL = "postgres://localhost/test";
			vi.mocked(PostgresDialect).mockClear();
		});

		afterEach(() => {
			process.env.DATABASE_URL = "";
		});

		it("calls deleteSandbox on the dialect and disconnects", async () => {
			await destroySandbox("postgres", "sandbox-abc");

			const MockedCtor = vi.mocked(PostgresDialect);
			expect(MockedCtor).toHaveBeenCalledWith("postgres://localhost/test");

			const instance = MockedCtor.mock.results[0]?.value as {
				deleteSandbox: ReturnType<typeof vi.fn>;
				disconnect: ReturnType<typeof vi.fn>;
			};
			expect(instance.deleteSandbox).toHaveBeenCalledWith({}, "sandbox-abc");
			expect(instance.disconnect).toHaveBeenCalled();
		});

		it("throws if DATABASE_URL is not set", async () => {
			process.env.DATABASE_URL = "";
			await expect(destroySandbox("postgres", "sandbox-abc")).rejects.toThrow("DATABASE_URL");
		});
	});
});
