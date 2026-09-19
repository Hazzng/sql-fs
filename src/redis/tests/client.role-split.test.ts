/**
 * #167: the data plane and the control plane must never share a socket, because
 * ioredis pipelines over one connection and a queue of multi-MiB blob SETs
 * head-of-line blocks the latency-critical lock/INCR commands behind them.
 *
 * `ioredis` is mocked so no real connection is opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Constructed {
	readonly url: string;
	readonly connectionName: unknown;
}

const constructed: Constructed[] = [];

vi.mock("ioredis", () => {
	class FakeRedis {
		constructor(url: string, options: { connectionName?: string }) {
			constructed.push({ url, connectionName: options.connectionName });
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

async function freshClientModule(): Promise<typeof import("../client.js")> {
	vi.resetModules();
	return import("../client.js");
}

beforeEach(() => {
	constructed.length = 0;
	vi.stubEnv("REDIS_URL", "redis://control.example:6379");
	vi.stubEnv("REDIS_DATA_URL", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getRedisClient role split", () => {
	it("returns a distinct client instance for the data role", async () => {
		const { getRedisClient } = await freshClientModule();
		const control = getRedisClient("control");
		const data = getRedisClient("data");
		expect(control).toBeDefined();
		expect(data).toBeDefined();
		expect(data).not.toBe(control);
	});

	it("opens one connection per role when only REDIS_URL is set", async () => {
		const { getRedisClient } = await freshClientModule();
		getRedisClient("control");
		getRedisClient("data");
		expect(constructed).toEqual([
			{ url: "redis://control.example:6379", connectionName: "sql-fs-control" },
			{ url: "redis://control.example:6379", connectionName: "sql-fs-data" },
		]);
	});

	it("defaults the control role when no role is given", async () => {
		const { getRedisClient } = await freshClientModule();
		expect(getRedisClient()).toBe(getRedisClient("control"));
		expect(getRedisClient()).not.toBe(getRedisClient("data"));
	});

	it("memoizes per role rather than process-wide", async () => {
		const { getRedisClient } = await freshClientModule();
		expect(getRedisClient("data")).toBe(getRedisClient("data"));
		getRedisClient("control");
		expect(constructed.map((c) => c.connectionName)).toEqual(["sql-fs-data", "sql-fs-control"]);
	});

	it("points the data role at REDIS_DATA_URL when it is set", async () => {
		vi.stubEnv("REDIS_DATA_URL", "redis://cache.example:6380");
		const { getRedisClient } = await freshClientModule();
		getRedisClient("control");
		getRedisClient("data");
		expect(constructed.map((c) => c.url)).toEqual(["redis://control.example:6379", "redis://cache.example:6380"]);
	});

	// Regression guard, not a fix-proving test: Redis stays entirely optional.
	it("returns undefined for both roles when no URL is configured", async () => {
		vi.stubEnv("REDIS_URL", undefined);
		const { getRedisClient } = await freshClientModule();
		expect(getRedisClient("control")).toBeUndefined();
		expect(getRedisClient("data")).toBeUndefined();
		expect(constructed).toEqual([]);
	});

	it("enables the data role from REDIS_DATA_URL alone when REDIS_URL is unset", async () => {
		vi.stubEnv("REDIS_URL", undefined);
		vi.stubEnv("REDIS_DATA_URL", "redis://cache.example:6380");
		const { getRedisClient } = await freshClientModule();
		expect(getRedisClient("control")).toBeUndefined();
		expect(getRedisClient("data")).toBeDefined();
		expect(constructed).toEqual([{ url: "redis://cache.example:6380", connectionName: "sql-fs-data" }]);
	});

	it("closes every role's client and does not reopen afterwards", async () => {
		const { getRedisClient, closeRedisClient } = await freshClientModule();
		const control = getRedisClient("control");
		const data = getRedisClient("data");
		const quitControl = vi.spyOn(control as never, "quit");
		const quitData = vi.spyOn(data as never, "quit");
		await closeRedisClient();
		expect(quitControl).toHaveBeenCalledTimes(1);
		expect(quitData).toHaveBeenCalledTimes(1);
		expect(getRedisClient("data")).toBeUndefined();
		expect(constructed).toHaveLength(2);
	});
});
