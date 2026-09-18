/**
 * Integration: `PostgresDialect.ingestBlobs` against a real database.
 * Verifies the touch-then-insert protocol — new blobs are stored, and blobs
 * that are already present have `last_referenced_at` bumped instead of being
 * rewritten.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { sha256Of } from "./fixtures.js";

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect.ingestBlobs", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const marker = `ingest-blobs-${Date.now()}`;
	const shas: Uint8Array[] = [];

	async function readRow(sha: Uint8Array): Promise<{ size: number; lastReferencedAt: Date } | null> {
		return dialect.transaction(async (tx) => {
			const rows = await (tx as unknown as (
				s: TemplateStringsArray,
				...v: unknown[]
			) => Promise<Array<{ size: number; last_referenced_at: Date }>>)`
				SELECT size, last_referenced_at FROM blobs WHERE sha256 = ${Buffer.from(sha)}
			`;
			const row = rows[0];
			return row ? { size: Number(row.size), lastReferencedAt: new Date(row.last_referenced_at) } : null;
		});
	}

	beforeAll(async () => {
		await dialect.connect();
	});

	afterAll(async () => {
		try {
			for (const sha of shas) {
				await dialect.transaction(async (tx) => {
					await (tx as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)`
						DELETE FROM blobs WHERE sha256 = ${Buffer.from(sha)}
					`;
				});
			}
		} finally {
			await dialect.disconnect();
		}
	});

	it("inserts blobs that are not stored yet", async () => {
		const a = sha256Of(`${marker}-a`);
		const b = sha256Of(`${marker}-b`);
		shas.push(a, b);

		await dialect.ingestBlobs([
			{ sha256: a, data: Buffer.from(`${marker}-a`) },
			{ sha256: b, data: Buffer.from(`${marker}-b`) },
		]);

		expect((await readRow(a))?.size).toBe(`${marker}-a`.length);
		expect((await readRow(b))?.size).toBe(`${marker}-b`.length);
	});

	it("bumps last_referenced_at for a blob that is already stored", async () => {
		const c = sha256Of(`${marker}-c`);
		shas.push(c);
		await dialect.ingestBlobs([{ sha256: c, data: Buffer.from(`${marker}-c`) }]);
		const before = (await readRow(c))!.lastReferencedAt;
		await new Promise((resolve) => setTimeout(resolve, 20));

		await dialect.ingestBlobs([{ sha256: c, data: Buffer.from(`${marker}-c`) }]);

		const after = (await readRow(c))!.lastReferencedAt;
		expect(after.getTime()).toBeGreaterThan(before.getTime());
	});

	it("stores a hash repeated within one batch exactly once", async () => {
		const d = sha256Of(`${marker}-d`);
		shas.push(d);

		await dialect.ingestBlobs([
			{ sha256: d, data: Buffer.from(`${marker}-d`) },
			{ sha256: d, data: Buffer.from(`${marker}-d`) },
		]);

		expect((await readRow(d))?.size).toBe(`${marker}-d`.length);
	});
});
