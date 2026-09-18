/**
 * Integration: `SqlFs.bulkGraft` round trip. Blobs are ingested with no
 * sandbox, then grafted into a sandbox by hash alone; the files must read back
 * through the normal path, and a hash that is not stored must be refused with
 * EGRAFTMISSING before anything is written.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";
import type { GraftFile } from "../../types.js";

function sha256(text: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(text).digest());
}

describe.skipIf(!process.env.DATABASE_URL)("SqlFs.bulkGraft — end-to-end", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxId = `test-graft-${Date.now()}`;
	const marker = sandboxId;
	const bodies = {
		"/site-packages/demo/__init__.py": `# ${marker} init\n`,
		"/site-packages/demo/sub/mod.py": `# ${marker} mod\n`,
	};

	beforeAll(async () => {
		await dialect.connect();
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId);
		});
		await dialect.ingestBlobs(Object.values(bodies).map((body) => ({ sha256: sha256(body), data: Buffer.from(body) })));
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

	it("grafts by hash and serves the bytes through readFile", async () => {
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
		const files: GraftFile[] = Object.entries(bodies).map(([path, body]) => ({
			path,
			sha256: sha256(body),
			mode: 0o644,
			size: Buffer.byteLength(body),
		}));

		await fs.bulkGraft(files);

		for (const [path, body] of Object.entries(bodies)) {
			const stat = await fs.stat(path);
			expect(stat.isFile).toBe(true);
			expect(stat.size).toBe(Buffer.byteLength(body));
			expect(await fs.readFile(path)).toBe(body);
		}
		expect((await fs.stat("/site-packages/demo/sub")).isDirectory).toBe(true);
	});

	it("survives a cold reload — the graft is durable, not cache-only", async () => {
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();

		expect(await fs.readFile("/site-packages/demo/sub/mod.py")).toBe(bodies["/site-packages/demo/sub/mod.py"]);
	});

	it("refuses a graft whose blob is not stored, writing nothing", async () => {
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
		const absent = sha256(`${marker} never ingested`);

		const err = (await fs
			.bulkGraft([{ path: "/site-packages/ghost/mod.py", sha256: absent, mode: 0o644, size: 4 }])
			.catch((e: unknown) => e)) as Error & { code?: string; missing?: string[] };

		expect(err.code).toBe("EGRAFTMISSING");
		expect(err.missing).toEqual([Buffer.from(absent).toString("hex")]);
		expect(await fs.exists("/site-packages/ghost/mod.py")).toBe(false);
	});
});
