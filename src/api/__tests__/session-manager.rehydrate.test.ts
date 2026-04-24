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
import type { SandboxMeta } from "../../fs/sql-fs/types.js";
import { SessionManager } from "../session-manager.js";

let pgSandboxes: Map<string, SandboxMeta>;

let createFsSpy: ReturnType<typeof vi.fn>;

function makeSessionManager(): SessionManager {
	pgSandboxes = new Map();
	createFsSpy = vi.fn(async (_backend: string, _sandboxId: string): Promise<IFileSystem> => {
		return new InMemoryFs();
	});
	return new SessionManager({
		backend: "memory",
		createFs: createFsSpy,
		getSandboxMetaFn: async (sandboxId: string) => pgSandboxes.get(sandboxId) ?? null,
		persistSandboxMetaFn: async (sandboxId: string, meta: SandboxMeta) => {
			pgSandboxes.set(sandboxId, meta);
		},
	});
}

const DEFAULT_META: SandboxMeta = { owner: null, python: false, javascript: false };

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
		pgSandboxes.set("sb-cold", DEFAULT_META);

		const result = await sm.withSessionOrRehydrate("sb-cold", async (session) => {
			return session.state;
		});
		expect(result).toBe("active");
		expect(createFsSpy).toHaveBeenCalledWith("memory", "sb-cold");
	});

	it("rehydrated session is warm on subsequent calls", async () => {
		pgSandboxes.set("sb-once", DEFAULT_META);

		await sm.withSessionOrRehydrate("sb-once", async () => "first");
		await sm.withSessionOrRehydrate("sb-once", async () => "second");

		expect(createFsSpy).toHaveBeenCalledTimes(1);
	});

	it("destroyed sandbox stays ENOENT even if PG set still contains it", async () => {
		pgSandboxes.set("sb-destroy", DEFAULT_META);

		await sm.withSessionOrRehydrate("sb-destroy", async () => "alive");

		await sm.destroy("sb-destroy");
		pgSandboxes.delete("sb-destroy");

		await expect(sm.withSessionOrRehydrate("sb-destroy", async () => "ghost")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("falls back to pool-only behavior when getSandboxMetaFn is not set", async () => {
		const smNoFn = new SessionManager({
			backend: "memory",
			createFs: createFsSpy,
		});

		await expect(smNoFn.withSessionOrRehydrate("cold-no-fn", async () => "nope")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("restores owner from PG metadata on rehydration", async () => {
		pgSandboxes.set("sb-owned", { owner: "user-a", python: false, javascript: false });

		let capturedOwner = "";
		await sm.withSessionOrRehydrate("sb-owned", async (session) => {
			capturedOwner = session.owner;
		});
		expect(capturedOwner).toBe("user-a");
	});

	it("restores runtime options from PG metadata on rehydration", async () => {
		pgSandboxes.set("sb-py", { owner: null, python: true, javascript: false });

		let capturedRuntime = { python: false, javascript: false };
		await sm.withSessionOrRehydrate("sb-py", async (session) => {
			capturedRuntime = session.runtimeOptions;
		});
		expect(capturedRuntime).toEqual({ python: true, javascript: false });
	});

	it("persistSandboxMeta writes to store and is readable on rehydration", async () => {
		await sm.withSession("sb-meta", async (session) => {
			session.owner = "creator";
			await sm.persistSandboxMeta("sb-meta", { owner: "creator", python: true, javascript: false });
		});

		// Simulate pool eviction by creating a new manager with same store
		const sm2 = new SessionManager({
			backend: "memory",
			createFs: createFsSpy,
			getSandboxMetaFn: async (sandboxId: string) => pgSandboxes.get(sandboxId) ?? null,
		});

		let owner = "";
		let runtime = { python: false, javascript: false };
		await sm2.withSessionOrRehydrate("sb-meta", async (session) => {
			owner = session.owner;
			runtime = session.runtimeOptions;
		});
		expect(owner).toBe("creator");
		expect(runtime).toEqual({ python: true, javascript: false });
	});
});
