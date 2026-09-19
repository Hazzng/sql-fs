/**
 * #167: the server must open a control connection AND a data connection, and
 * hand the data one to the blob cache / path snapshot. With a single shared
 * connection, multi-MiB blob writes head-of-line block the lock and version
 * commands, which is what turned a 6 s Redis stall into a replica-wide 503
 * storm. `ioredis` is mocked so no real connection is opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed: string[] = [];
const snapshotConstructed: unknown[] = [];

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

vi.mock("../../../sql-fs/redis-path-snapshot.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../../sql-fs/redis-path-snapshot.js")>();
	class CountingSnapshot extends mod.RedisPathSnapshot {
		constructor(...args: ConstructorParameters<typeof mod.RedisPathSnapshot>) {
			super(...args);
			snapshotConstructed.push(1);
		}
	}
	return { ...mod, RedisPathSnapshot: CountingSnapshot };
});

beforeEach(() => {
	constructed.length = 0;
	snapshotConstructed.length = 0;
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
		vi.stubEnv("REDIS_PATH_SNAPSHOT_ENABLED", "true");
		await import("../../server.js");
		expect(constructed).toEqual(["sql-fs-control", "sql-fs-data"]);
		expect(snapshotConstructed).toHaveLength(1);
	});

	it("opens only the control connection when no data-plane feature is enabled", async () => {
		vi.resetModules();
		vi.stubEnv("REDIS_URL", "redis://localhost:6379");
		vi.stubEnv("REDIS_DATA_URL", undefined);
		vi.stubEnv("REDIS_BLOB_CACHE_ENABLED", "false");
		vi.stubEnv("REDIS_PATH_SNAPSHOT_ENABLED", "false");
		await import("../../server.js");
		expect(constructed).toEqual(["sql-fs-control"]);
		expect(snapshotConstructed).toHaveLength(0);
	});

	it("builds no path snapshot from a data-only connection without control", async () => {
		vi.resetModules();
		vi.stubEnv("REDIS_URL", undefined);
		vi.stubEnv("REDIS_DATA_URL", "redis://localhost:6379");
		vi.stubEnv("REDIS_BLOB_CACHE_ENABLED", undefined);
		vi.stubEnv("REDIS_PATH_SNAPSHOT_ENABLED", "true");
		await import("../../server.js");
		// No REDIS_URL, so no control connection. The data connection still
		// opens (blob cache defaults on) but no snapshot is built: every
		// snapshot read is version-checked against the control-side counter.
		expect(constructed).toEqual(["sql-fs-data"]);
		expect(snapshotConstructed).toHaveLength(0);
	});
});
