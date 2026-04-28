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
	createFsSpy = vi.fn(async (_tenantId: string, _sandboxId: string): Promise<IFileSystem> => {
		return new InMemoryFs();
	});
	return new SessionManager({
		createFs: createFsSpy,
		destroySandboxFn: async (_tenantId: string, sandboxId: string) => {
			pgSandboxes.delete(sandboxId);
		},
		getSandboxMetaFn: async (_tenantId: string, sandboxId: string) => pgSandboxes.get(sandboxId) ?? null,
		persistSandboxMetaFn: async (_tenantId: string, sandboxId: string, meta: SandboxMeta) => {
			pgSandboxes.set(sandboxId, meta);
		},
	});
}

const DEFAULT_META: SandboxMeta = { owner: null, name: null, python: false, javascript: false };

describe("SessionManager.withSessionOrRehydrate()", () => {
	let sm: SessionManager;

	beforeEach(() => {
		sm = makeSessionManager();
	});

	it("returns result from warm session without PG check", async () => {
		// Warm the pool via withSession (which calls getOrCreate)
		await sm.withSession("default", "sb-1", async () => "warmed");

		const result = await sm.withSessionOrRehydrate("default", "sb-1", async (session) => {
			return `hello from ${session.state}`;
		});
		expect(result).toBe("hello from active");
		// createFs called only once (during warmup), not again
		expect(createFsSpy).toHaveBeenCalledTimes(1);
	});

	it("throws ENOENT when sandbox does not exist in pool or PG", async () => {
		await expect(sm.withSessionOrRehydrate("default", "nonexistent", async () => "nope")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rehydrates from PG when sandbox exists in DB but not in pool", async () => {
		pgSandboxes.set("sb-cold", DEFAULT_META);

		const result = await sm.withSessionOrRehydrate("default", "sb-cold", async (session) => {
			return session.state;
		});
		expect(result).toBe("active");
		expect(createFsSpy).toHaveBeenCalledWith("default", "sb-cold");
	});

	it("rehydrated session is warm on subsequent calls", async () => {
		pgSandboxes.set("sb-once", DEFAULT_META);

		await sm.withSessionOrRehydrate("default", "sb-once", async () => "first");
		await sm.withSessionOrRehydrate("default", "sb-once", async () => "second");

		expect(createFsSpy).toHaveBeenCalledTimes(1);
	});

	it("destroyed sandbox stays ENOENT even if PG set still contains it", async () => {
		pgSandboxes.set("sb-destroy", DEFAULT_META);

		await sm.withSessionOrRehydrate("default", "sb-destroy", async () => "alive");

		await sm.destroy("default", "sb-destroy");

		await expect(sm.withSessionOrRehydrate("default", "sb-destroy", async () => "ghost")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("falls back to pool-only behavior when getSandboxMetaFn is not set", async () => {
		const smNoFn = new SessionManager({
			createFs: createFsSpy,
		});

		await expect(smNoFn.withSessionOrRehydrate("default", "cold-no-fn", async () => "nope")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("restores owner from PG metadata on rehydration", async () => {
		pgSandboxes.set("sb-owned", { owner: "user-a", name: null, python: false, javascript: false });

		let capturedOwner = "";
		await sm.withSessionOrRehydrate("default", "sb-owned", async (session) => {
			capturedOwner = session.owner;
		});
		expect(capturedOwner).toBe("user-a");
	});

	it("restores runtime options from PG metadata on rehydration", async () => {
		pgSandboxes.set("sb-py", { owner: null, name: null, python: true, javascript: false });

		let capturedRuntime = { python: false, javascript: false };
		await sm.withSessionOrRehydrate("default", "sb-py", async (session) => {
			capturedRuntime = session.runtimeOptions;
		});
		expect(capturedRuntime).toEqual({ python: true, javascript: false });
	});

	it("persistSandboxMeta writes to store and is readable on rehydration", async () => {
		await sm.withSession("default", "sb-meta", async (session) => {
			session.owner = "creator";
			await sm.persistSandboxMeta("default", "sb-meta", {
				owner: "creator",
				name: null,
				python: true,
				javascript: false,
			});
		});

		// Simulate pool eviction by creating a new manager with same store
		const sm2 = new SessionManager({
			createFs: createFsSpy,
			getSandboxMetaFn: async (_tenantId: string, sandboxId: string) => pgSandboxes.get(sandboxId) ?? null,
		});

		let owner = "";
		let runtime = { python: false, javascript: false };
		await sm2.withSessionOrRehydrate("default", "sb-meta", async (session) => {
			owner = session.owner;
			runtime = session.runtimeOptions;
		});
		expect(owner).toBe("creator");
		expect(runtime).toEqual({ python: true, javascript: false });
	});
});
