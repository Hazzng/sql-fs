/**
 * Integration tests for PostgresDialect per-sandbox advisory lock (Phase B).
 *
 * Verifies that setSandboxContextWithLock + deleteSandbox serialize concurrent mutators
 * on the same sandboxId via pg_advisory_xact_lock(hashtextextended(sandboxId, 0)),
 * and that unrelated sandboxes do not contend.
 *
 * Skipped when DATABASE_URL is not set so CI without a DB still passes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";

const SKIP = !process.env.DATABASE_URL;

/** Wait for a deferred promise with a timeout guard so a hung lock is diagnostic, not a test-runner hang. */
const DEFAULT_TIMEOUT_MS = 5_000;
function timed<T>(label: string, p: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

describe.skipIf(SKIP)("PostgresDialect — per-sandbox advisory lock", () => {
	// Each test needs independent PG connection pools so concurrent transactions
	// actually run on different physical connections (one Sql pool per dialect).
	let dialectA: PostgresDialect;
	let dialectB: PostgresDialect;
	let dialectC: PostgresDialect;
	const createdSandboxIds: string[] = [];

	beforeAll(async () => {
		dialectA = new PostgresDialect(process.env.DATABASE_URL!);
		dialectB = new PostgresDialect(process.env.DATABASE_URL!);
		dialectC = new PostgresDialect(process.env.DATABASE_URL!);
		await Promise.all([dialectA.connect(), dialectB.connect(), dialectC.connect()]);
	});

	afterAll(async () => {
		// Best-effort cleanup: delete any sandbox rows created during the tests.
		for (const sandboxId of createdSandboxIds) {
			try {
				await dialectA.transaction(async (tx) => {
					await tx`DELETE FROM sandboxes WHERE id = ${sandboxId}`;
				});
			} catch {
				// Already deleted — ignore.
			}
		}
		await Promise.all([dialectA.disconnect(), dialectB.disconnect(), dialectC.disconnect()]);
	});

	it("concurrent transactions on the same sandboxId serialize on the advisory lock", async () => {
		const sandboxId = `lock-same-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const holdMs = 500;

		// Gate A: the first transaction signals once it has the lock; then holds for holdMs.
		let firstHasLock!: () => void;
		const firstHasLockPromise = new Promise<void>((resolve) => {
			firstHasLock = resolve;
		});

		const firstStart = Date.now();
		const first = dialectA.transaction(async (tx) => {
			await dialectA.setSandboxContextWithLock(tx, sandboxId);
			firstHasLock();
			await new Promise((r) => setTimeout(r, holdMs));
			return "first-done";
		});

		// Wait until the first transaction definitely holds the lock before starting the second.
		await firstHasLockPromise;

		const secondStart = Date.now();
		const second = dialectB.transaction(async (tx) => {
			await dialectB.setSandboxContextWithLock(tx, sandboxId);
			return Date.now() - secondStart;
		});

		const [firstResult, secondWaitMs] = await Promise.all([timed("first", first), timed("second", second)]);
		const totalMs = Date.now() - firstStart;

		expect(firstResult).toBe("first-done");
		// The second txn's lock-wait must not finish before the first releases.
		// Allow ~50ms of scheduling slack below the 500ms hold.
		expect(secondWaitMs).toBeGreaterThanOrEqual(holdMs - 50);
		// Total wall time is bounded: holdMs + a little overhead, well under the timeout.
		expect(totalMs).toBeLessThan(holdMs + 2_000);
	});

	it("different sandboxIds do not contend on the advisory lock", async () => {
		const sandboxA = `lock-diff-a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const sandboxB = `lock-diff-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const holdMs = 400;

		const started = Date.now();
		const [durA, durB] = await Promise.all([
			timed(
				"sandboxA",
				dialectA.transaction(async (tx) => {
					await dialectA.setSandboxContextWithLock(tx, sandboxA);
					await new Promise((r) => setTimeout(r, holdMs));
					return Date.now() - started;
				}),
			),
			timed(
				"sandboxB",
				dialectB.transaction(async (tx) => {
					await dialectB.setSandboxContextWithLock(tx, sandboxB);
					await new Promise((r) => setTimeout(r, holdMs));
					return Date.now() - started;
				}),
			),
		]);

		// Both finish ~in parallel. Total wall time should be ~holdMs, not ~2×holdMs.
		const total = Math.max(durA, durB);
		expect(total).toBeLessThan(holdMs + 300);
	});

	it("destroy-vs-write race: deleteSandbox blocks on an in-flight writer holding the lock", async () => {
		// Create a sandbox first so the DELETE has something to remove.
		const sandboxId = `lock-destroy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		await dialectC.transaction(async (tx) => {
			await dialectC.createSandbox(tx, sandboxId);
		});
		createdSandboxIds.push(sandboxId);

		const holdMs = 400;
		let writerHasLock!: () => void;
		const writerHasLockPromise = new Promise<void>((resolve) => {
			writerHasLock = resolve;
		});

		const writer = dialectA.transaction(async (tx) => {
			await dialectA.setSandboxContextWithLock(tx, sandboxId);
			writerHasLock();
			await new Promise((r) => setTimeout(r, holdMs));
			return "writer-done";
		});

		await writerHasLockPromise;

		const destroyStart = Date.now();
		const destroyer = dialectB.transaction(async (tx) => {
			await dialectB.deleteSandbox(tx, sandboxId);
			return Date.now() - destroyStart;
		});

		const [writerResult, destroyWaitMs] = await Promise.all([timed("writer", writer), timed("destroyer", destroyer)]);

		expect(writerResult).toBe("writer-done");
		expect(destroyWaitMs).toBeGreaterThanOrEqual(holdMs - 50);

		// Confirm the sandbox is actually gone.
		const rows = await dialectC.transaction(
			async (tx) => await tx<{ id: string }[]>`SELECT id FROM sandboxes WHERE id = ${sandboxId}`,
		);
		expect(rows).toHaveLength(0);
	});

	it("advisory lock is released on ROLLBACK so subsequent writers proceed immediately", async () => {
		const sandboxId = `lock-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		// First transaction acquires the lock then throws, forcing a ROLLBACK.
		await expect(
			dialectA.transaction(async (tx) => {
				await dialectA.setSandboxContextWithLock(tx, sandboxId);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// Second transaction should acquire the same lock immediately (well under 200ms).
		const start = Date.now();
		await timed(
			"post-rollback",
			dialectB.transaction(async (tx) => {
				await dialectB.setSandboxContextWithLock(tx, sandboxId);
			}),
		);
		const waitMs = Date.now() - start;
		expect(waitMs).toBeLessThan(500);
	});

	it("read-only setSandboxContext does NOT block a concurrent writer", async () => {
		const sandboxId = `lock-read-free-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const holdMs = 500;

		// Reader acquires lock-free context and holds the transaction open.
		let readerReady!: () => void;
		const readerReadyPromise = new Promise<void>((resolve) => {
			readerReady = resolve;
		});
		const reader = dialectA.transaction(async (tx) => {
			await dialectA.setSandboxContext(tx, sandboxId);
			readerReady();
			await new Promise((r) => setTimeout(r, holdMs));
		});

		await readerReadyPromise;

		// Writer must proceed without waiting on the reader.
		const writerStart = Date.now();
		await timed(
			"writer-unblocked",
			dialectB.transaction(async (tx) => {
				await dialectB.setSandboxContextWithLock(tx, sandboxId);
			}),
		);
		const writerWaitMs = Date.now() - writerStart;

		await reader;

		// Well under the reader's hold: the writer was not serialized on it.
		expect(writerWaitMs).toBeLessThan(holdMs / 2);
	});
});
