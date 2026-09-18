/**
 * Phase 4 integration: two replicas, one Redis, one Postgres, one download.
 *
 * Each "replica" is a `Bash` assembled the way `SessionManager` assembles one
 * (its own `SqlFs`, the package store injected into the commands) plus its own
 * Redis connection and its own `createRedisWheelLease` — the same two objects
 * `SessionManager.buildPythonPackageCommands` wires when `REDIS_URL` is set.
 * The shell is built here rather than taken from a `SessionManager` for one
 * reason: the manager builds its own PyPI fetch, and this test's whole assertion
 * is a count of wheel fetches.
 *
 * Skipped unless both DATABASE_URL and REDIS_URL are set.
 */

import { Redis } from "ioredis";
import { Bash } from "just-bash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { asPackageStore } from "../../../sql-fs/package-store.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { createPythonPackageCommands } from "../../commands/pip-command.js";
import { createRedisWheelLease } from "../../commands/pip-wheel-store.js";
import { wheelLockKey } from "../../distributed-lock.js";
import { fixtureFetch, sha256, wheel } from "../unit/pip-fixtures.js";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;
const TENANT = "default";
const suffix = `${Date.now()}`;

const demoWheel = wheel("demo", "1.0", { "demo/__init__.py": `VALUE = "${suffix}"\n` });
const packages = { demo: { version: "1.0", body: demoWheel } };
const wheelHash = sha256(demoWheel);
const wheelKey = Buffer.from(wheelHash, "hex");

describe.skipIf(SKIP)("pip singleflight — two replicas, one Redis", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxes = [`pip-sf-a-${suffix}`, `pip-sf-b-${suffix}`] as const;
	const counter = { wheels: 0 };
	const clients: Redis[] = [];

	/** One replica: its own Redis client, its own wheel lease, its own sandbox. */
	async function replica(sandboxId: string): Promise<Bash & { fs: SqlFs }> {
		const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
		await redis.connect();
		clients.push(redis);
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
		const inner = fixtureFetch(packages);
		return new Bash({
			fs,
			python: true,
			fetch: (url, options) => {
				if (new URL(url).hostname === "files.pythonhosted.org") counter.wheels += 1;
				return inner(url, options);
			},
			customCommands: createPythonPackageCommands({
				packageStore: asPackageStore(fs)!,
				withWheelLease: createRedisWheelLease({ redis, tenantId: TENANT }),
			}),
		}) as Bash & { fs: SqlFs };
	}

	beforeAll(async () => {
		await dialect.connect();
		for (const id of sandboxes) await dialect.transaction((tx) => dialect.createSandbox(tx, id));
	});

	afterAll(async () => {
		try {
			for (const id of sandboxes) {
				await dialect.transaction(async (tx) => {
					await tx`DELETE FROM sandbox_packages WHERE sandbox_id = ${id}`;
					await dialect.deleteSandbox(tx, id);
				});
			}
			await dialect.transaction(async (tx) => {
				await tx`DELETE FROM package_manifests WHERE wheel_sha256 = ${wheelKey}`;
			});
		} finally {
			if (clients[0] !== undefined) await clients[0].del(wheelLockKey(TENANT, wheelHash));
			for (const client of clients) client.disconnect();
			await dialect.disconnect();
		}
	});

	it("downloads the wheel once when both replicas install it cold at the same time", async () => {
		const [first, second] = await Promise.all([replica(sandboxes[0]), replica(sandboxes[1])]);
		const results = await Promise.all([first.exec("pip install demo"), second.exec("pip install demo")]);

		for (const result of results) {
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe("Successfully installed demo-1.0\n");
		}
		expect(counter.wheels).toBe(1);
		for (const bash of [first, second]) {
			expect(await bash.fs.readFile("/site-packages/demo/__init__.py")).toBe(`VALUE = "${suffix}"\n`);
			expect((await bash.exec("pip freeze")).stdout).toBe("demo==1.0\n");
		}
		const rows = await dialect.transaction(
			(tx) => tx`SELECT sandbox_id FROM sandbox_packages WHERE wheel_sha256 = ${wheelKey} ORDER BY sandbox_id`,
		);
		expect(rows.map((row) => String(row.sandbox_id))).toEqual([sandboxes[0], sandboxes[1]]);
		// The lease is released before the install loop moves on, so nothing is left.
		expect(await clients[0]!.get(wheelLockKey(TENANT, wheelHash))).toBe(null);
	});
});
