/**
 * RLS on `sandbox_packages` (migration 0007): the ledger is sandbox-scoped, so
 * it carries the same policy shape as `inodes` / `dirents` (0005).
 *
 * Unlike `rls.integration.test.ts` this suite runs NO DDL: 0007 is applied by
 * the startup migration runner, and re-running `ALTER TABLE` from a test that
 * shares the database takes ACCESS EXCLUSIVE locks and deadlocks against other
 * suites running in parallel.
 *
 * Skipped when DATABASE_URL is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import type { GraftFile, PackageManifest } from "../../types.js";
import { sha256Of } from "./fixtures.js";

const SKIP = !process.env.DATABASE_URL;

describe.skipIf(SKIP)("sandbox_packages — RLS sandbox isolation (0007)", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const suffix = `${Date.now()}`;
	const sandboxA = `pkg-rls-a-${suffix}`;
	const sandboxB = `pkg-rls-b-${suffix}`;
	const wheel = sha256Of(`rls-wheel-${suffix}`);

	const content = new TextEncoder().encode(`rls-blob-${suffix}\n`);
	const blobSha = sha256Of(content);
	const files: readonly GraftFile[] = [
		{ path: "/site-packages/rlsdemo/__init__.py", sha256: blobSha, mode: 0o644, size: content.length },
	];
	const manifest: PackageManifest = {
		wheelSha256: wheel,
		manifestFormat: 1,
		name: "rlsdemo",
		version: "1.0.0",
		fileCount: 1,
		totalBytes: content.length,
	};

	beforeAll(async () => {
		await dialect.connect();
		await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxA, "owner-a"));
		await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxB, "owner-b"));
		await dialect.ingestBlobs([{ sha256: blobSha, data: content }]);
		await dialect.recordManifest(manifest, files);
		for (const [sandboxId, version] of [
			[sandboxA, "1.0.0"],
			[sandboxB, "2.0.0"],
		] as const) {
			await dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, sandboxId);
				await dialect.upsertSandboxPackages(tx, [{ name: "rlsdemo", version, wheelSha256: wheel }]);
			});
		}
	});

	afterAll(async () => {
		try {
			await dialect.transaction((tx) => dialect.deleteSandbox(tx, sandboxA));
			await dialect.transaction((tx) => dialect.deleteSandbox(tx, sandboxB));
			await dialect.transaction(async (tx) => {
				await tx`DELETE FROM package_manifests WHERE wheel_sha256 = ${Buffer.from(wheel)}`;
				await tx`DELETE FROM blobs WHERE sha256 = ${Buffer.from(blobSha)}`;
			});
		} finally {
			await dialect.disconnect();
		}
	});

	it("an unfiltered read under sandbox A's context returns only sandbox A's ledger rows", async () => {
		const rows = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxA);
			return await tx<{ sandbox_id: string; version: string }[]>`SELECT sandbox_id, version FROM sandbox_packages`;
		});

		expect(rows).toEqual([{ sandbox_id: sandboxA, version: "1.0.0" }]);
	});

	it("sandbox B's context cannot see sandbox A's ledger row even with an explicit filter", async () => {
		const n = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxB);
			const rows = await tx<{ n: number }[]>`
				SELECT count(*)::int AS n FROM sandbox_packages WHERE sandbox_id = ${sandboxA}
			`;
			return rows[0]!.n;
		});

		expect(n).toBe(0);
	});

	it("listSandboxPackages returns only the current sandbox's rows", async () => {
		const forB = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxB);
			return await dialect.listSandboxPackages(tx);
		});

		expect(forB).toEqual([{ name: "rlsdemo", version: "2.0.0", wheelSha256: wheel }]);
	});

	it("a write under sandbox B's context cannot target sandbox A (WITH CHECK)", async () => {
		await expect(
			dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, sandboxB);
				await tx`
					INSERT INTO sandbox_packages (sandbox_id, name, version, wheel_sha256)
					VALUES (${sandboxA}, ${"smuggled"}, ${"9.9.9"}, ${Buffer.from(wheel)})
				`;
			}),
		).rejects.toThrow();

		const n = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxA);
			const rows = await tx<{ n: number }[]>`
				SELECT count(*)::int AS n FROM sandbox_packages WHERE name = ${"smuggled"}
			`;
			return rows[0]!.n;
		});
		expect(n).toBe(0);
	});

	it("a context-less connection (the GC path) still sees both sandboxes' rows", async () => {
		const ids = await dialect.transaction(async (tx) => {
			const rows = await tx<{ sandbox_id: string }[]>`
				SELECT sandbox_id FROM sandbox_packages
				WHERE sandbox_id IN (${sandboxA}, ${sandboxB})
				ORDER BY sandbox_id
			`;
			return rows.map((r) => r.sandbox_id);
		});

		expect(ids).toEqual([sandboxA, sandboxB].sort());
	});
});
