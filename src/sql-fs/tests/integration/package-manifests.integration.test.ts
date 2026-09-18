/**
 * Integration tests for the package-manifest dialect methods (migration 0007):
 * record / lookup / loadManifestFiles / touch / delete, against a real Postgres.
 *
 * Skipped when DATABASE_URL is not set. Every manifest and ledger row created
 * here is removed in `afterEach`, so the GC suite next door sees a clean table.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { MANIFEST_FORMAT } from "../../package-manifest.js";
import type { GraftFile, PackageManifest } from "../../types.js";
import { hex, sha256Of } from "./fixtures.js";

const SKIP = !process.env.DATABASE_URL;

describe.skipIf(SKIP)("PostgresDialect — package manifests (0007)", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const suffix = `${Date.now()}`;
	const sandboxId = `pkg-manifest-${suffix}`;
	const wheel = sha256Of(`wheel-${suffix}`);

	/** Blob bytes shared by the manifests below. */
	const fileA = new TextEncoder().encode(`print("a-${suffix}")\n`);
	const fileB = new TextEncoder().encode(`print("b-${suffix}")\n`);
	const shaA = sha256Of(fileA);
	const shaB = sha256Of(fileB);

	const files: readonly GraftFile[] = [
		{ path: "/site-packages/demo/__init__.py", sha256: shaA, mode: 0o644, size: fileA.length },
		{ path: "/site-packages/demo/core.py", sha256: shaB, mode: 0o644, size: fileB.length },
	];

	function manifest(format = MANIFEST_FORMAT, version = "1.0.0"): PackageManifest {
		return {
			wheelSha256: wheel,
			manifestFormat: format,
			name: "demo",
			version,
			fileCount: files.length,
			totalBytes: fileA.length + fileB.length,
		};
	}

	beforeAll(async () => {
		await dialect.connect();
		await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxId));
		await dialect.ingestBlobs([
			{ sha256: shaA, data: fileA },
			{ sha256: shaB, data: fileB },
		]);
	});

	afterEach(async () => {
		await dialect.transaction(async (tx) => {
			await tx`DELETE FROM sandbox_packages WHERE sandbox_id = ${sandboxId}`;
			await tx`DELETE FROM package_manifests WHERE wheel_sha256 = ${Buffer.from(wheel)}`;
		});
	});

	afterAll(async () => {
		try {
			await dialect.transaction((tx) => dialect.deleteSandbox(tx, sandboxId));
			await dialect.transaction(async (tx) => {
				await tx`DELETE FROM blobs WHERE sha256 IN (${Buffer.from(shaA)}, ${Buffer.from(shaB)})`;
			});
		} finally {
			await dialect.disconnect();
		}
	});

	it("records a manifest and reads it back with lookupManifest", async () => {
		await dialect.recordManifest(manifest(), files);

		expect(await dialect.lookupManifest(wheel, MANIFEST_FORMAT)).toEqual({
			wheelSha256: wheel,
			manifestFormat: MANIFEST_FORMAT,
			name: "demo",
			version: "1.0.0",
			fileCount: 2,
			totalBytes: fileA.length + fileB.length,
		});
	});

	it("loadManifestFiles returns every file row of the wheel, path-ordered", async () => {
		await dialect.recordManifest(manifest(), files);

		const loaded = await dialect.loadManifestFiles([wheel]);

		expect([...loaded.keys()]).toEqual([hex(wheel)]);
		expect(loaded.get(hex(wheel))).toEqual([
			{ path: "/site-packages/demo/__init__.py", sha256: shaA, mode: 0o644, size: fileA.length },
			{ path: "/site-packages/demo/core.py", sha256: shaB, mode: 0o644, size: fileB.length },
		]);
	});

	it("a row written in an older manifest_format is a miss and is replaced", async () => {
		await dialect.recordManifest(manifest(MANIFEST_FORMAT - 1, "0.9.0"), files);

		expect(await dialect.lookupManifest(wheel, MANIFEST_FORMAT)).toBeUndefined();

		await dialect.recordManifest(manifest(MANIFEST_FORMAT, "1.0.0"), files);

		const found = await dialect.lookupManifest(wheel, MANIFEST_FORMAT);
		expect(found?.version).toBe("1.0.0");
		expect(found?.manifestFormat).toBe(MANIFEST_FORMAT);
		// Replaced, not duplicated: the wheel hash is the primary key.
		const rows = await dialect.transaction(
			async (tx) =>
				await tx<
					{ n: number }[]
				>`SELECT count(*)::int AS n FROM package_manifests WHERE wheel_sha256 = ${Buffer.from(wheel)}`,
		);
		expect(rows[0]?.n).toBe(1);
	});

	it("recordManifest throws EGRAFTMISSING and writes nothing when a blob is absent", async () => {
		const absent = sha256Of(`never-stored-${suffix}`);
		const withAbsent: readonly GraftFile[] = [
			...files,
			{ path: "/site-packages/demo/missing.py", sha256: absent, mode: 0o644, size: 3 },
		];

		await expect(dialect.recordManifest(manifest(), withAbsent)).rejects.toMatchObject({
			code: "EGRAFTMISSING",
			missing: [hex(absent)],
		});

		expect(await dialect.lookupManifest(wheel, MANIFEST_FORMAT)).toBeUndefined();
		expect(await dialect.loadManifestFiles([wheel])).toEqual(new Map());
	});

	it("touchManifests bumps last_used_at", async () => {
		await dialect.recordManifest(manifest(), files);
		const before = await dialect.transaction(
			async (tx) =>
				await tx<
					{ last_used_at: Date }[]
				>`SELECT last_used_at FROM package_manifests WHERE wheel_sha256 = ${Buffer.from(wheel)}`,
		);
		// Age the row so the bump is observable regardless of clock resolution.
		await dialect.transaction(async (tx) => {
			await tx`UPDATE package_manifests SET last_used_at = now() - interval '1 hour' WHERE wheel_sha256 = ${Buffer.from(wheel)}`;
		});

		await dialect.touchManifests([wheel]);

		const after = await dialect.transaction(
			async (tx) =>
				await tx<
					{ last_used_at: Date }[]
				>`SELECT last_used_at FROM package_manifests WHERE wheel_sha256 = ${Buffer.from(wheel)}`,
		);
		expect(after[0]!.last_used_at.getTime()).toBeGreaterThanOrEqual(before[0]!.last_used_at.getTime());
	});

	it("deleteManifest removes the manifest and cascades its file rows", async () => {
		await dialect.recordManifest(manifest(), files);

		await dialect.deleteManifest(wheel);

		expect(await dialect.lookupManifest(wheel, MANIFEST_FORMAT)).toBeUndefined();
		expect(await dialect.loadManifestFiles([wheel])).toEqual(new Map());
	});

	it("deleteManifest of a manifest an installed sandbox references fails with EMANIFESTINUSE", async () => {
		await dialect.recordManifest(manifest(), files);
		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.upsertSandboxPackages(tx, [{ name: "demo", version: "1.0.0", wheelSha256: wheel }]);
		});

		await expect(dialect.deleteManifest(wheel)).rejects.toMatchObject({ code: "EMANIFESTINUSE" });
		// The manifest is untouched, and no raw driver error reached the caller.
		expect((await dialect.lookupManifest(wheel, MANIFEST_FORMAT))?.name).toBe("demo");
	});

	it("the ledger round trips through upsert / list / delete under the sandbox context", async () => {
		await dialect.recordManifest(manifest(), files);

		const listed = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.upsertSandboxPackages(tx, [{ name: "demo", version: "1.0.0", wheelSha256: wheel }]);
			return await dialect.listSandboxPackages(tx);
		});
		expect(listed).toEqual([{ name: "demo", version: "1.0.0", wheelSha256: wheel }]);

		const afterUpgrade = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.upsertSandboxPackages(tx, [{ name: "demo", version: "2.0.0", wheelSha256: wheel }]);
			return await dialect.listSandboxPackages(tx);
		});
		expect(afterUpgrade).toEqual([{ name: "demo", version: "2.0.0", wheelSha256: wheel }]);

		const afterDelete = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.deleteSandboxPackage(tx, "demo");
			return await dialect.listSandboxPackages(tx);
		});
		expect(afterDelete).toEqual([]);
	});
});
