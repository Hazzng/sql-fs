/**
 * Integration test for `SqlFs.bulkIngest` — exercises the cache-coherence
 * wrapper end-to-end against a real Postgres. The dialect-level bulkIngest
 * primitive is covered separately in `postgres.test.ts`; this suite verifies
 * the SqlFs layer (advisory lock + reload + dirty flag).
 *
 * Skipped when DATABASE_URL is not set so CI without a DB still passes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";
import type { BulkIngestFile } from "../../types.js";

describe.skipIf(!process.env.DATABASE_URL)("SqlFs.bulkIngest — end-to-end through cache-coherence wrapper", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxId = `test-sqlfs-bulk-${Date.now()}`;

	beforeAll(async () => {
		await dialect.connect();
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId);
		});
	});

	afterAll(async () => {
		try {
			await dialect.transaction(async (tx) => {
				await dialect.deleteSandbox(tx, sandboxId);
			});
		} finally {
			await dialect.disconnect();
		}
	});

	it("ingests ~50 files across nested dirs and every file is readable via SqlFs", async () => {
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();

		const dirs = ["alpha", "alpha/x", "beta", "beta/y", "gamma"];
		const files: BulkIngestFile[] = [];
		for (const dir of dirs) {
			for (let i = 0; i < 10; i++) {
				files.push({
					path: `/home/user/${dir}/file${i}.txt`,
					content: new TextEncoder().encode(`content-${dir}-${i}`),
					mode: 0o644,
				});
			}
		}

		await fs.bulkIngest(files);

		// pathCache must contain every ingested path (driven by reload())
		for (const f of files) {
			const stat = await fs.stat(f.path);
			expect(stat.isFile).toBe(true);
			expect(stat.size).toBe(f.content.byteLength);
		}

		// readFile pulls each blob from the DB on first access
		for (const f of files) {
			const text = await fs.readFile(f.path);
			expect(text).toBe(new TextDecoder().decode(f.content));
		}
	});
});
