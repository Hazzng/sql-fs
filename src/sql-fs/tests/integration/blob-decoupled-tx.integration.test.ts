/**
 * F6 integration: decoupled CAS blob commit.
 *
 * Proves (a) `commitBlob` dedups + round-trips, and (b) the decoupled-tx fix —
 * a `commitBlob` of a hot blob does NOT serialize behind a concurrent long-lived
 * script-tx that has already written (touched) the same blob row.
 *
 * Before the fix, `writeFileComposite`'s `blob_insert` CTE ran inside the
 * advisory-locked script-tx, holding the `ON CONFLICT DO UPDATE` tuple lock on
 * the hot blob until COMMIT; a concurrent touch of the same row would block for
 * the whole script. After the fix the blob is touched in its own short tx, so
 * the second `commitBlob` returns promptly even while the first script-tx is
 * open.
 *
 * Skipped when DATABASE_URL is not set so CI without a DB still passes.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";

const SKIP = !process.env.DATABASE_URL;

function timed<T>(label: string, p: Promise<T>, timeoutMs = 5_000): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

describe.skipIf(SKIP)("PostgresDialect — F6 decoupled blob commit", () => {
	let dialectA: PostgresDialect;
	let dialectB: PostgresDialect;
	const createdSandboxIds: string[] = [];

	beforeAll(async () => {
		dialectA = new PostgresDialect(process.env.DATABASE_URL!);
		dialectB = new PostgresDialect(process.env.DATABASE_URL!);
		await Promise.all([dialectA.connect(), dialectB.connect()]);
	});

	afterAll(async () => {
		for (const sandboxId of createdSandboxIds) {
			try {
				await dialectA.transaction(async (tx) => {
					await tx`DELETE FROM sandboxes WHERE id = ${sandboxId}`;
				});
			} catch {
				// already gone
			}
		}
		await Promise.all([dialectA.disconnect(), dialectB.disconnect()]);
	});

	it("commitBlob dedups and round-trips identical content under one sha", async () => {
		const data = new TextEncoder().encode(`f6-dedup-${Date.now()}-${Math.random()}`);
		const sha = new Uint8Array(createHash("sha256").update(data).digest());

		await dialectA.commitBlob(sha, data);
		await dialectA.commitBlob(sha, data); // idempotent touch

		const rows = await dialectA.transaction(
			async (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM blobs WHERE sha256 = ${sha}`,
		);
		expect(rows[0]?.n).toBe("1");

		const fetched = await dialectA.getBlobNoTx(sha);
		expect(fetched).not.toBeNull();
		expect(Buffer.from(fetched!).equals(Buffer.from(data))).toBe(true);
	});

	it("writeFileComposite no longer touches the blob, so a held script-tx does not pin the hot-blob lock", async () => {
		// Model the F6 scenario: sandbox A commits the hot blob (short tx) then runs
		// a long script that writes a file referencing it via writeFileComposite and
		// holds the script-tx open. Sandbox B then commitBlobs the SAME bytes — with
		// the fix, writeFileComposite no longer touches the blob row, so B's short
		// upsert is not blocked by A's open script-tx.
		const data = new TextEncoder().encode(`f6-hot-${Date.now()}-${Math.random()}`);
		const sha = new Uint8Array(createHash("sha256").update(data).digest());
		const holdMs = 1_500;

		// Set up sandbox A with a root dir we can write into.
		const sandboxId = `f6-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		createdSandboxIds.push(sandboxId);
		const rootInodeId = await dialectA.transaction(async (tx) => {
			await dialectA.setSandboxContextWithLock(tx, sandboxId);
			const { rootInodeId } = await dialectA.createSandbox(tx, sandboxId);
			return rootInodeId;
		});

		// A: commit the blob first (short tx), as the SqlFs write path now does.
		await dialectA.commitBlob(sha, data);

		let inComposite!: () => void;
		const inCompositePromise = new Promise<void>((resolve) => {
			inComposite = resolve;
		});
		let release!: () => void;
		const releasePromise = new Promise<void>((resolve) => {
			release = resolve;
		});

		// A: open a long-lived script-tx and run writeFileComposite (which must NOT
		// touch the blob row anymore), then hold the tx open.
		const longTx = dialectA.transaction(async (tx) => {
			await dialectA.writeFileComposite!(tx, sandboxId, rootInodeId, "hot.txt", 0o644, data.length, sha, data);
			inComposite();
			await releasePromise;
		});

		await timed("wait for composite", inCompositePromise);

		// B: commit the SAME blob in its own short tx. Must NOT block on A's open tx.
		const start = Date.now();
		await timed("concurrent commitBlob", dialectB.commitBlob(sha, data), 2_000);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(holdMs);

		release();
		await timed("release long tx", longTx);
	});
});
