import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { makeProbeDialect } from "../../../sql-fs/tests/fixtures/buffered-dialect.js";
import { makePausedPostgresRetirement } from "../../../sql-fs/tests/fixtures/postgres-retirement.js";
import * as distributedLock from "../../distributed-rw-lock.js";
import { SessionManager } from "../../session-manager.js";

const managers: SessionManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
	vi.restoreAllMocks();
});

async function fixture() {
	const probe = makeProbeDialect();
	const { blocked, resume, retire } = makePausedPostgresRetirement(probe);
	probe.dialect.retireSandboxGeneration = retire;
	const leases: AbortController[] = [];
	vi.spyOn(distributedLock, "withDistributedRWLock").mockImplementation(async (_redis, _keys, _mode, fn) => {
		const lease = new AbortController();
		leases.push(lease);
		return fn(lease.signal);
	});
	async function manager() {
		const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "inline-generation" });
		await fs.ready();
		const owner = new SessionManager({
			workerEnabled: false,
			createFs: async () => fs,
			redis: {} as Redis,
		});
		managers.push(owner);
		await owner.getOrCreate("default", "inline-generation", { python: false, javascript: false, network: false });
		return { owner, fs };
	}
	return { probe, blocked, resume, leases, manager };
}

describe("inline session generation lease fencing", () => {
	it.each(["withSession", "withSessionRead"] as const)(
		"%s rejects the stale claimant after a replacement acquires its generation",
		async (entry) => {
			const test = await fixture();
			const stale = await test.manager();
			const replacement = await test.manager();
			const callback = vi.fn(async () => "stale");
			const pending = stale.owner[entry]("default", "inline-generation", callback);
			const settled = pending.then(
				() => undefined,
				(error: unknown) => error,
			);
			await test.blocked.promise;
			test.leases[0]!.abort();
			await replacement.owner.withSession("default", "inline-generation", async () => "replacement");
			const epoch = test.probe.version;
			test.resume.resolve();
			expect(await settled).toMatchObject({ code: "ELOCKLOST" });
			expect(callback).not.toHaveBeenCalled();
			expect(test.probe.version).toBe(epoch);
			await expect(replacement.fs.writeFile("/home/user/replacement", "writable")).resolves.toBeUndefined();
			expect(await replacement.fs.readFile("/home/user/replacement")).toBe("writable");
		},
	);

	it("keeps overlapping shared entries bound to their own asynchronous lease", async () => {
		const test = await fixture();
		const { owner } = await test.manager();
		const callback = vi.fn(async () => "stale");
		const first = owner.withSessionRead("default", "inline-generation", callback);
		const settled = first.then(
			() => undefined,
			(error: unknown) => error,
		);
		await test.blocked.promise;
		test.leases[0]!.abort();
		await expect(owner.withSessionRead("default", "inline-generation", async () => "healthy")).resolves.toBe("healthy");
		const epoch = test.probe.version;
		test.resume.resolve();
		expect(await settled).toMatchObject({ code: "ELOCKLOST" });
		expect(callback).not.toHaveBeenCalled();
		expect(test.probe.version).toBe(epoch);
	});
});
