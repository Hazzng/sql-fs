/**
 * #167: the server must open a control connection AND a data connection, and
 * hand the data one to the blob cache / path snapshot. With a single shared
 * connection, multi-MiB blob writes head-of-line block the lock and version
 * commands, which is what turned a 6 s Redis stall into a replica-wide 503
 * storm. `ioredis` is mocked so no real connection is opened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("server Redis role wiring", () => {
	it("opens one control connection and one data connection at boot", async () => {
		vi.resetModules();
		vi.stubEnv("REDIS_URL", "redis://localhost:6379");
		vi.stubEnv("REDIS_PATH_SNAPSHOT_ENABLED", "true");
		await import("../../server.js");
		expect(constructed).toEqual(["sql-fs-control", "sql-fs-data"]);
	});
});
