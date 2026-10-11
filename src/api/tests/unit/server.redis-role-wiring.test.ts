import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed: string[] = [];

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

describe("server Redis role wiring", () => {
	// Every test stubs every wiring var: ambient REDIS_URL / REDIS_DATA_URL /
	// feature flags must not leak in (an exported REDIS_URL would otherwise
	// open a control connection in the data-only test below).
	it("opens one control connection and one data connection at boot", async () => {
		vi.resetModules();
		vi.stubEnv("REDIS_URL", "redis://localhost:6379");
		vi.stubEnv("REDIS_DATA_URL", undefined);
		vi.stubEnv("REDIS_BLOB_CACHE_ENABLED", undefined);
		await import("../../server.js");
		expect(constructed).toEqual(["sql-fs-control", "sql-fs-data"]);
	});

	it("opens only the control connection when no data-plane feature is enabled", async () => {
		vi.resetModules();
		vi.stubEnv("REDIS_URL", "redis://localhost:6379");
		vi.stubEnv("REDIS_DATA_URL", undefined);
		vi.stubEnv("REDIS_BLOB_CACHE_ENABLED", "false");
		await import("../../server.js");
		expect(constructed).toEqual(["sql-fs-control"]);
	});

	it("opens only the blob connection when the control URL is absent", async () => {
		vi.resetModules();
		vi.stubEnv("REDIS_URL", undefined);
		vi.stubEnv("REDIS_DATA_URL", "redis://localhost:6379");
		vi.stubEnv("REDIS_BLOB_CACHE_ENABLED", undefined);
		await import("../../server.js");
		expect(constructed).toEqual(["sql-fs-data"]);
	});
});
