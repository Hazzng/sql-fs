import { Redis } from "ioredis";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { destroySandbox } from "../../../sql-fs/index.js";
import type { SqlFs } from "../../../sql-fs/sql-fs.js";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";

const TENANT = "default";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

const DEFAULT_TIMEOUT_MS = 15_000;
function timed<T>(label: string, p: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

function versionKey(sandboxId: string): string {
	return `vfs:${TENANT}:ver:${sandboxId}`;
}

describe.skipIf(SKIP)("cross-replica committed cache coherence", () => {
	let redis: Redis;
	const cleanup: string[] = [];

	beforeAll(async () => {
		redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
		await redis.connect();
	});

	beforeEach(() => {
		cleanup.length = 0;
	});

	afterEach(async () => {
		for (const id of cleanup) {
			try {
				await destroySandbox("postgres", id);
			} catch {
				/* ignore */
			}
			const { writer, readers } = rwLockKeys(TENANT, id);
			await redis.del(writer, readers);
			await redis.del(versionKey(id));
		}
	});

	function makeSm(): SessionManager {
		return new SessionManager({
			tenantConfig: loadTenantConfig(),
			redis,
			execLockOptions: {
				leaseMs: 5_000,
				renewMs: 1_500,
				acquireTimeoutMs: 8_000,
				acquireRetryMs: 50,
			},
		});
	}

	function newId(): string {
		const id = `phase-d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		cleanup.push(id);
		return id;
	}

	it("write on A → read on B reloads and sees the new file", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();

		// Both replicas warm the session first so they each have a pool entry.
		await smA.withSession(TENANT, sandboxId, async () => {
			/* create */
		});
		await smB.withSession(TENANT, sandboxId, async () => {
			/* warm on B */
		});

		// Before A writes, B's session should not have the file in its pathCache.
		const bSessionBefore = smB.getSession(TENANT, sandboxId)!;
		expect(bSessionBefore.fs.getAllPaths()).not.toContain("/from-a.txt");

		await timed(
			"A-write",
			smA.withSession(TENANT, sandboxId, async (s) => {
				await s.bash.exec("echo hello > /from-a.txt");
			}),
		);

		// B's next exec must reload and see /from-a.txt.
		await timed(
			"B-read",
			smB.withSession(TENANT, sandboxId, async (s) => {
				const content = await s.fs.readFile("/from-a.txt");
				expect(String(content).trim()).toBe("hello");
				// And the pathCache now reflects the reload.
				expect(s.fs.getAllPaths()).toContain("/from-a.txt");
			}),
		);
	});

	it("no reload when no other replica wrote in between", async () => {
		const sandboxId = newId();
		const sm = makeSm();

		await sm.withSession(TENANT, sandboxId, async () => {
			/* warm */
		});

		const fs = sm.getSession(TENANT, sandboxId)!.fs as SqlFs;
		const before = fs._getPathCache();

		// Pure-read turn (no mutation)
		await sm.withSession(TENANT, sandboxId, async (s) => {
			await s.bash.exec("ls /");
		});

		expect(fs._getPathCache()).toBe(before);
	});

	it("destroy tears down a peer replica's warm session without Redis metadata", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();

		await smA.withSession(TENANT, sandboxId, async (s) => {
			await s.bash.exec("echo bye > /x.txt");
		});
		// B warms a session against the live sandbox before A destroys it.
		await smB.withSession(TENANT, sandboxId, async (s) => {
			expect(String(await s.fs.readFile("/x.txt")).trim()).toBe("bye");
		});

		expect(await redis.get(versionKey(sandboxId))).toBeNull();

		await smA.destroy(TENANT, sandboxId);

		await expect(
			smB.withSession(TENANT, sandboxId, async (s) => {
				await s.fs.readFile("/x.txt");
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("alternating writes across replicas converge on the latest version", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();

		await smA.withSession(TENANT, sandboxId, async (s) => {
			await s.bash.exec("echo a1 > /ping.txt");
		});
		await smB.withSession(TENANT, sandboxId, async (s) => {
			const current = String(await s.fs.readFile("/ping.txt")).trim();
			expect(current).toBe("a1");
			await s.bash.exec("echo b1 > /pong.txt");
		});
		await smA.withSession(TENANT, sandboxId, async (s) => {
			const pong = String(await s.fs.readFile("/pong.txt")).trim();
			expect(pong).toBe("b1");
		});
	});
});
