/**
 * Unit tests for SessionManager.withSessionOrRehydrate().
 *
 * Tests the three code paths:
 * 1. Warm hit: sandbox in pool -> execute immediately
 * 2. Cold hit: sandbox in PG but not in pool -> rehydrate via getOrCreate
 * 3. Cold miss: sandbox not in PG -> throw ENOENT
 */
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";

let pgSandboxes: Set<string>;

let createFsSpy: ReturnType<typeof vi.fn>;

function makeSessionManager(): SessionManager {
	pgSandboxes = new Set();
	createFsSpy = vi.fn(async (_backend: string, _sandboxId: string): Promise<IFileSystem> => {
		return new InMemoryFs();
	});
	return new SessionManager({
		backend: "memory",
		createFs: createFsSpy,
		sandboxExistsFn: async (sandboxId: string) => pgSandboxes.has(sandboxId),
	});
}

describe("SessionManager.withSessionOrRehydrate()", () => {
	let sm: SessionManager;

	beforeEach(() => {
		sm = makeSessionManager();
	});

	it("returns result from warm session without PG check", async () => {
		// Warm the pool via withSession (which calls getOrCreate)
		await sm.withSession("sb-1", async () => "warmed");

		const result = await sm.withSessionOrRehydrate("sb-1", async (session) => {
			return `hello from ${session.state}`;
		});
		expect(result).toBe("hello from active");
		// createFs called only once (during warmup), not again
		expect(createFsSpy).toHaveBeenCalledTimes(1);
	});

	it("throws ENOENT when sandbox does not exist in pool or PG", async () => {
		await expect(sm.withSessionOrRehydrate("nonexistent", async () => "nope")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rehydrates from PG when sandbox exists in DB but not in pool", async () => {
		// Simulate: sandbox was created on another replica (exists in PG)
		pgSandboxes.add("sb-cold");

		const result = await sm.withSessionOrRehydrate("sb-cold", async (session) => {
			return session.state;
		});
		expect(result).toBe("active");
		// createFs called once for the rehydration
		expect(createFsSpy).toHaveBeenCalledWith("memory", "sb-cold");
	});

	it("rehydrated session is warm on subsequent calls", async () => {
		pgSandboxes.add("sb-once");

		// First call: rehydrates
		await sm.withSessionOrRehydrate("sb-once", async () => "first");
		// Second call: warm hit
		await sm.withSessionOrRehydrate("sb-once", async () => "second");

		// createFs called only once (rehydration), not twice
		expect(createFsSpy).toHaveBeenCalledTimes(1);
	});

	it("destroyed sandbox stays ENOENT even if PG set still contains it", async () => {
		pgSandboxes.add("sb-destroy");

		// Rehydrate first
		await sm.withSessionOrRehydrate("sb-destroy", async () => "alive");

		// Destroy removes from pool (and in real PG would delete the row)
		await sm.destroy("sb-destroy");

		// Simulate PG row being gone (destroy deletes it)
		pgSandboxes.delete("sb-destroy");

		await expect(sm.withSessionOrRehydrate("sb-destroy", async () => "ghost")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("falls back to pool-only behavior when sandboxExistsFn is not set", async () => {
		const smNoFn = new SessionManager({
			backend: "memory",
			createFs: createFsSpy,
			// No sandboxExistsFn — strict pool-only mode
		});

		await expect(smNoFn.withSessionOrRehydrate("cold-no-fn", async () => "nope")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
