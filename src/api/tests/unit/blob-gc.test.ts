/**
 * Unit tests for the multi-tenant blob GC orchestrator `runBlobGc`.
 * US-014 (Phase 4)
 *
 * The SUT constructs `new PostgresDialect(url)` and `new RedisBlobCache(redis, tenantId)`
 * internally, so both modules are mocked. `vi.mock` factories are hoisted above
 * imports and cannot close over normal top-level variables, so the shared mutable
 * mock-state object is created via `vi.hoisted` and referenced inside the factories.
 */

import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBlobGc } from "../../blob-gc.js";
import type { TenantConfig } from "../../tenants.js";

const OK_URL = "postgres://localhost/ok";
const BOOM_URL = "postgres://localhost/boom";

const SHA_T1: Uint8Array[] = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

const state = vi.hoisted(() => ({
	connected: [] as string[],
	disconnected: [] as string[],
	minAgeMsSeen: [] as number[],
	mdelCalls: [] as Array<{ tenantId: string; shas: ReadonlyArray<Uint8Array> }>,
	// Per-url configured GC return values.
	gcReturns: new Map<string, Uint8Array[]>(),
}));

vi.mock("../../../sql-fs/dialects/postgres.js", () => ({
	PostgresDialect: class {
		readonly #url: string;
		constructor(url: string) {
			this.#url = url;
		}
		async connect(): Promise<void> {
			state.connected.push(this.#url);
			if (this.#url.includes("boom")) {
				throw new Error("connect failed: boom");
			}
		}
		async disconnect(): Promise<void> {
			state.disconnected.push(this.#url);
		}
		async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
			return fn({});
		}
		async gcOrphanBlobs(_tx: unknown, minAgeMs: number): Promise<Uint8Array[]> {
			state.minAgeMsSeen.push(minAgeMs);
			return state.gcReturns.get(this.#url) ?? [];
		}
	},
}));

vi.mock("../../../sql-fs/redis-blob-cache.js", () => ({
	RedisBlobCache: class {
		readonly #tenantId: string;
		constructor(_client: unknown, tenantId: string) {
			this.#tenantId = tenantId;
		}
		async mdel(shas: ReadonlyArray<Uint8Array>): Promise<void> {
			state.mdelCalls.push({ tenantId: this.#tenantId, shas });
		}
	},
}));

function makeTenantConfig(): TenantConfig {
	const map = new Map<string, string>([
		["t1", OK_URL],
		["t2", BOOM_URL],
	]);
	return {
		tenantIds: ["t1", "t2"],
		hasTenant: (id) => map.has(id),
		getConnectionString: (id) => {
			const v = map.get(id);
			if (v === undefined) throw new Error(`Unknown tenant: ${id}`);
			return v;
		},
	};
}

const fakeRedis = {} as Redis;

beforeEach(() => {
	state.connected.length = 0;
	state.disconnected.length = 0;
	state.minAgeMsSeen.length = 0;
	state.mdelCalls.length = 0;
	state.gcReturns.clear();
	state.gcReturns.set(OK_URL, SHA_T1);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("runBlobGc", () => {
	it("connects and disconnects every tenant, including the failing one (finally)", async () => {
		await runBlobGc(makeTenantConfig(), { minAgeMs: 1000, redis: fakeRedis });

		expect(state.connected).toEqual([OK_URL, BOOM_URL]);
		expect(state.disconnected).toEqual([OK_URL, BOOM_URL]);
	});

	it("passes minAgeMs through to gcOrphanBlobs", async () => {
		await runBlobGc(makeTenantConfig(), { minAgeMs: 4242, redis: fakeRedis });

		// Only t1 reaches gcOrphanBlobs (t2 fails at connect).
		expect(state.minAgeMsSeen).toEqual([4242]);
	});

	it("calls mdel with the deleted sha256s for the succeeding tenant when redis is enabled", async () => {
		await runBlobGc(makeTenantConfig(), { minAgeMs: 0, redis: fakeRedis });

		expect(state.mdelCalls).toEqual([{ tenantId: "t1", shas: SHA_T1 }]);
	});

	it("is resilient: one tenant failing does not abort the others", async () => {
		const results = await runBlobGc(makeTenantConfig(), { minAgeMs: 0, redis: fakeRedis });

		expect(results).toHaveLength(2);
		const t1 = results.find((r) => r.tenantId === "t1");
		const t2 = results.find((r) => r.tenantId === "t2");

		expect(t1).toEqual({ tenantId: "t1", deleted: SHA_T1.length });
		expect(t2?.tenantId).toBe("t2");
		expect(t2?.deleted).toBe(0);
		expect(t2?.error).toBeTruthy();
		expect(t2?.error).toContain("boom");
	});

	it("does not call mdel when redis is absent", async () => {
		await runBlobGc(makeTenantConfig(), { minAgeMs: 0, redis: undefined });

		expect(state.mdelCalls).toEqual([]);
	});

	it("does not call mdel when blobCacheEnabled is false", async () => {
		await runBlobGc(makeTenantConfig(), { minAgeMs: 0, redis: fakeRedis, blobCacheEnabled: false });

		expect(state.mdelCalls).toEqual([]);
	});
});
