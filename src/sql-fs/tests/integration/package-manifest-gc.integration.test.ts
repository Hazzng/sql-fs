/**
 * Integration tests for manifests as a GC root (migration 0007 + gcOrphanBlobs).
 *
 * Three orderings matter and are asserted here: a manifest keeps its blobs
 * alive, an expired unreferenced manifest and its blobs go in ONE pass (the
 * manifest DELETE precedes the blob anti-join in the same transaction), and a
 * manifest an installed sandbox references is never collected.
 *
 * Skipped when DATABASE_URL is not set. Every row created here is removed in
 * `afterEach`, including on failure, so `manifestsDeleted` stays exact.
 */

import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { MANIFEST_FORMAT } from "../../package-manifest.js";
import type { GraftFile, PackageManifest } from "../../types.js";

const SKIP = !process.env.DATABASE_URL;

/** 30 days — the production default, used wherever the TTL must not fire. */
const LONG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sha256Of(bytes: Uint8Array | string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

describe.skipIf(SKIP)("gcOrphanBlobs — package manifests as a GC root", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const suffix = `${Date.now()}`;
	const sandboxId = `pkg-gc-${suffix}`;
	const wheel = sha256Of(`gc-wheel-${suffix}`);

	const content = new TextEncoder().encode(`manifest-only-blob-${suffix}\n`);
	const blobSha = sha256Of(content);

	const files: readonly GraftFile[] = [
		{ path: "/site-packages/gcdemo/__init__.py", sha256: blobSha, mode: 0o644, size: content.length },
	];
	const manifest: PackageManifest = {
		wheelSha256: wheel,
		manifestFormat: MANIFEST_FORMAT,
		name: "gcdemo",
		version: "1.0.0",
		fileCount: 1,
		totalBytes: content.length,
	};

	/** One GC pass at REPEATABLE READ, as `runBlobGc` does it. */
	async function gc(minAgeMs: number, manifestTtlMs: number) {
		return await dialect.transaction((tx) => dialect.gcOrphanBlobs(tx, { minAgeMs, manifestTtlMs }), {
			isolationLevel: "repeatable read",
		});
	}

	async function blobExists(): Promise<boolean> {
		return (await dialect.getBlobNoTx(blobSha)) !== null;
	}

	async function recordFreshManifest(): Promise<void> {
		await dialect.ingestBlobs([{ sha256: blobSha, data: content }]);
		await dialect.recordManifest(manifest, files);
	}

	beforeAll(async () => {
		await dialect.connect();
		await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxId));
	});

	afterEach(async () => {
		await dialect.transaction(async (tx) => {
			await tx`DELETE FROM sandbox_packages WHERE sandbox_id = ${sandboxId}`;
			await tx`DELETE FROM package_manifests WHERE wheel_sha256 = ${Buffer.from(wheel)}`;
			await tx`DELETE FROM blobs WHERE sha256 = ${Buffer.from(blobSha)}`;
		});
	});

	afterAll(async () => {
		try {
			await dialect.transaction((tx) => dialect.deleteSandbox(tx, sandboxId));
		} finally {
			await dialect.disconnect();
		}
	});

	it("a blob referenced only by a manifest survives GC with minAgeMs 0", async () => {
		await recordFreshManifest();

		const result = await gc(0, LONG_TTL_MS);

		expect(result.manifestsDeleted).toBe(0);
		expect(result.deletedBlobs.map((b) => Buffer.from(b).toString("hex"))).not.toContain(
			Buffer.from(blobSha).toString("hex"),
		);
		expect(await blobExists()).toBe(true);
	});

	it("manifestTtlMs 0 collects the manifest and its blob in one pass", async () => {
		await recordFreshManifest();

		const result = await gc(0, 0);

		expect(result.manifestsDeleted).toBe(1);
		expect(result.deletedBlobs.map((b) => Buffer.from(b).toString("hex"))).toContain(
			Buffer.from(blobSha).toString("hex"),
		);
		expect(await blobExists()).toBe(false);
		expect(await dialect.lookupManifest(wheel, MANIFEST_FORMAT)).toBeUndefined();
	});

	it("a manifest an installed sandbox references survives manifestTtlMs 0, and so does its blob", async () => {
		await recordFreshManifest();
		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.upsertSandboxPackages(tx, [{ name: "gcdemo", version: "1.0.0", wheelSha256: wheel }]);
		});

		const result = await gc(0, 0);

		expect(result.manifestsDeleted).toBe(0);
		expect((await dialect.lookupManifest(wheel, MANIFEST_FORMAT))?.name).toBe("gcdemo");
		expect(await blobExists()).toBe(true);
	});

	it("the manifest becomes collectible once the ledger row is gone", async () => {
		await recordFreshManifest();
		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.upsertSandboxPackages(tx, [{ name: "gcdemo", version: "1.0.0", wheelSha256: wheel }]);
		});
		expect((await gc(0, 0)).manifestsDeleted).toBe(0);

		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.deleteSandboxPackage(tx, "gcdemo");
		});

		expect((await gc(0, 0)).manifestsDeleted).toBe(1);
		expect(await blobExists()).toBe(false);
	});
});
