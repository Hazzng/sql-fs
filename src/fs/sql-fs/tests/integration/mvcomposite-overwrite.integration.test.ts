/**
 * Integration test for mvComposite overwriting an existing destination file
 * (audit M10). Previously the single wCTE raised a spurious unique_violation
 * (→ EEXIST) when renaming a dirent into a slot whose row was being deleted in
 * the same statement. The two-statement form must overwrite cleanly.
 *
 * Skipped when DATABASE_URL is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect.mvComposite — overwrite (M10)", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxId = `mv-ovw-${Date.now()}`;

	beforeAll(async () => {
		await dialect.connect();
		await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxId, "owner"));
	});

	afterAll(async () => {
		try {
			await dialect.transaction((tx) => dialect.deleteSandbox(tx, sandboxId));
		} finally {
			await dialect.disconnect();
		}
	});

	it("renames a file onto an existing file without raising EEXIST", async () => {
		// Resolve /home/user (created by createSandbox) and write src + dst there.
		const dirId = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			return dialect.resolvePath(tx, "/home/user", true);
		});

		const enc = new TextEncoder();
		const srcBytes = enc.encode("source");
		const dstBytes = enc.encode("destination");
		const sha = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

		await dialect.transaction(async (tx) => {
			await dialect.writeFileComposite!(
				tx,
				sandboxId,
				dirId,
				"src",
				0o644,
				srcBytes.length,
				await sha(srcBytes),
				srcBytes,
			);
		});
		await dialect.transaction(async (tx) => {
			await dialect.writeFileComposite!(
				tx,
				sandboxId,
				dirId,
				"dst",
				0o644,
				dstBytes.length,
				await sha(dstBytes),
				dstBytes,
			);
		});

		// The overwrite: rename src -> dst, where dst already exists.
		await expect(
			dialect.transaction((tx) => dialect.mvComposite!(tx, sandboxId, dirId, "src", dirId, "dst")),
		).resolves.toBeUndefined();

		// dst now resolves to the source's inode; src is gone.
		const afterDst = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			return dialect.resolvePath(tx, "/home/user/dst", true);
		});
		expect(typeof afterDst).toBe("bigint");

		await expect(
			dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, sandboxId);
				return dialect.resolvePath(tx, "/home/user/src", true);
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
