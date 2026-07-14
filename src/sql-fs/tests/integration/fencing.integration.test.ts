/**
 * Real-Postgres regressions for durable sandbox fencing (migration 0007).
 *
 * These tests deliberately use separate transactions for the stale reader and
 * the replacement writer.  The stale transaction has an RLS context and a
 * pinned epoch, but does not retain the writer advisory lock: that models a
 * lease which expired before its first mutation.
 *
 * Skipped when DATABASE_URL is not set so local/unit-only runs remain useful.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";

const SKIP = !process.env.DATABASE_URL;
const RLS_MIGRATION = fileURLToPath(new URL("../../migrations/postgres/0005_enable_rls.sql", import.meta.url));
const FENCING_MIGRATION = fileURLToPath(
	new URL("../../migrations/postgres/0007_fence_sandbox_epochs.sql", import.meta.url),
);

type Sandbox = Awaited<ReturnType<PostgresDialect["createSandbox"]>> & { id: string };

function uniqueId(label: string): string {
	return `fencing-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

describe.skipIf(SKIP)("Postgres fencing regressions", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxIds = new Set<string>();

	beforeAll(async () => {
		await dialect.connect();
		const rlsDdl = readFileSync(RLS_MIGRATION, "utf8");
		await dialect.transaction((tx) => tx.unsafe(rlsDdl));
	});

	afterAll(async () => {
		for (const id of sandboxIds) {
			try {
				await dialect.transaction(async (tx) => {
					await dialect.deleteSandbox(tx, id);
					await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
				});
			} catch {
				// A failed test may already have removed the live row; cleanup is best effort.
				try {
					await dialect.transaction(async (tx) => {
						await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
					});
				} catch {
					// The connection is closed below; do not hide the test failure.
				}
			}
		}
		await dialect.disconnect();
	});

	async function createSandbox(label: string): Promise<Sandbox> {
		const id = uniqueId(label);
		sandboxIds.add(id);
		const created = await dialect.transaction((tx) => dialect.createSandbox(tx, id));
		return { ...created, id };
	}

	it("applies migration 0007 idempotently and gives a fresh sandbox epoch zero", async () => {
		const ddl = readFileSync(FENCING_MIGRATION, "utf8");
		await dialect.transaction((tx) => tx.unsafe(ddl));
		await dialect.transaction((tx) => tx.unsafe(ddl));

		const columns = await dialect.transaction(
			(tx) => tx<{ data_type: string; column_default: string | null; is_nullable: string }[]>`
				SELECT data_type, column_default, is_nullable
				FROM information_schema.columns
				WHERE table_name = 'sandboxes' AND column_name = 'version'
			`,
		);
		expect(columns).toEqual([expect.objectContaining({ data_type: "bigint", is_nullable: "NO" })]);
		expect(columns[0]?.column_default).toContain("0");

		const sandbox = await createSandbox("initial");
		const row = await dialect.transaction(
			(tx) => tx<{ version: string; epoch: string }[]>`
				SELECT s.version, e.epoch
				FROM sandboxes s
				JOIN sandbox_epochs e ON e.sandbox_id = s.id
				WHERE s.id = ${sandbox.id}
			`,
		);
		expect(sandbox.epoch).toBe(0n);
		expect(row).toEqual([{ version: "0", epoch: "0" }]);
	});

	it("rejects a stale first mutation after a committed live append", async () => {
		const sandbox = await createSandbox("zombie");
		const staleReady = deferred();
		const replacementCommitted = deferred();
		const liveContent = new TextEncoder().encode("live append");
		const liveSha = new Uint8Array(32).fill(0x31);

		const staleTransaction = dialect.transaction(async (tx) => {
			// This is intentionally the non-locking context path: a lease can expire
			// while the script transaction is waiting before its first mutation.
			await dialect.setSandboxContext(tx, sandbox.id);
			const staleEpoch = await dialect.getSandboxEpoch(tx, sandbox.id);
			staleReady.resolve();
			await replacementCommitted.promise;

			// The CTE fence sees the replacement's newer epoch and produces no inode,
			// so the transaction rejects and rolls back rather than becoming a zombie.
			await dialect.writeFileComposite(
				tx,
				sandbox.id,
				sandbox.rootInodeId,
				"zombie.txt",
				0o644,
				liveContent.length,
				liveSha,
				liveContent,
				staleEpoch,
			);
		});

		await staleReady.promise;
		const replacement = await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandbox.id);
			const recreated = await dialect.createSandbox(tx, sandbox.id, "replacement");
			await tx`
				INSERT INTO blobs (sha256, data, size)
				VALUES (${liveSha}, ${liveContent}, ${liveContent.length})
				ON CONFLICT (sha256) DO UPDATE SET data = EXCLUDED.data, size = EXCLUDED.size
			`;
			await dialect.writeFileComposite(
				tx,
				sandbox.id,
				recreated.rootInodeId,
				"live.txt",
				0o644,
				liveContent.length,
				liveSha,
				liveContent,
				recreated.epoch,
			);
			return recreated;
		});
		replacementCommitted.resolve();

		await expect(staleTransaction).rejects.toThrow("writeFileComposite: INSERT returned no rows");

		const visible = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandbox.id);
			const rows = await tx<{ name: string; inode_id: string }[]>`
				SELECT name, inode_id FROM dirents
				WHERE parent_inode_id = ${String(replacement.rootInodeId)}
				ORDER BY name
			`;
			return rows;
		});
		expect(visible.map((row) => row.name)).toContain("live.txt");
		expect(visible.map((row) => row.name)).not.toContain("zombie.txt");
	});

	it("keeps a destroyed ID fenced across recreation on the non-superuser RLS path", async () => {
		const sandbox = await createSandbox("reuse");
		const identity = await dialect.transaction(
			(tx) => tx<{ current_user: string; rolsuper: boolean }[]>`
				SELECT current_user, r.rolsuper
				FROM pg_roles r
				WHERE r.rolname = current_user
			`,
		);
		expect(identity).toHaveLength(1);
		expect(identity[0]?.rolsuper).toBe(false);

		const staleEpoch = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandbox.id);
			const epochs = await tx<{ epoch: string }[]>`
				SELECT version AS epoch FROM sandboxes WHERE id = ${sandbox.id}
			`;
			return BigInt(epochs[0]!.epoch);
		});

		const recreated = await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandbox.id);
			return await dialect.createSandbox(tx, sandbox.id, "new-owner");
		});
		expect(recreated.epoch).toBeGreaterThan(staleEpoch);

		await expect(
			dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, sandbox.id);
				await dialect.mkdirComposite(tx, sandbox.id, recreated.rootInodeId, "old-scope-dir", 0o755, staleEpoch);
			}),
		).rejects.toThrow("mkdirComposite: INSERT returned no rows");

		const replacementRows = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandbox.id);
			return await tx<{ id: string; version: string }[]>`
				SELECT id, version FROM sandboxes WHERE id = ${sandbox.id}
			`;
		});
		expect(replacementRows).toEqual([{ id: sandbox.id, version: recreated.epoch.toString() }]);
	});

	it("allows the live non-superuser RLS transaction to mutate only its own sandbox", async () => {
		const sandbox = await createSandbox("rls");
		const other = await createSandbox("rls-other");
		const identity = await dialect.transaction(
			(tx) => tx<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
				SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
			`,
		);
		expect(identity[0]?.rolsuper).toBe(false);
		const created = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandbox.id);
			const own = await tx<{ n: number }[]>`
				SELECT count(*)::int AS n FROM inodes WHERE sandbox_id = ${sandbox.id}
			`;
			const otherRows = await tx<{ n: number }[]>`
				SELECT count(*)::int AS n FROM inodes WHERE sandbox_id = ${other.id}
			`;
			const inodeId = await dialect.mkdirComposite(
				tx,
				sandbox.id,
				sandbox.rootInodeId,
				"rls-dir",
				0o755,
				sandbox.epoch,
			);
			return { own: own[0]!.n, other: otherRows[0]!.n, inodeId };
		});

		expect(created.own).toBeGreaterThan(0);
		if (identity[0]?.rolbypassrls === false) {
			expect(created.other).toBe(0);
		} else {
			// The local Neon owner is non-superuser but has BYPASSRLS; validation
			// with an enforcing app role takes the branch above.
			expect(created.other).toBeGreaterThan(0);
		}
		expect(created.inodeId).toBeGreaterThan(0n);
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
