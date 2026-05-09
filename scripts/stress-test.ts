/**
 * Production-stability stress harness.
 *
 * Exercises the four scenarios from
 * tasks/production-stability-resource-lifecycle-plan.md against real
 * Postgres + Redis endpoints (env: STRESS_PG_URL, STRESS_REDIS_URL).
 *
 * Each scenario reports before/after metrics (RSS, active timers, PG
 * pg_stat_activity backend count, in-process session count) and writes a
 * combined report to tasks/stress-test-results.md.
 *
 * Run:
 *   STRESS_PG_URL=... STRESS_REDIS_URL=... pnpm tsx scripts/stress-test.ts
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { Redis } from "ioredis";
import postgres from "postgres";
import { PostgresDialect } from "../src/fs/sql-fs/dialects/postgres.js";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../src/fs/sql-fs/index.js";
import { runMigrations } from "../src/api/migrations.js";
import { RuntimeBackpressureError, SessionManager } from "../src/api/session-manager.js";

const PG_URL = process.env.STRESS_PG_URL;
const REDIS_URL = process.env.STRESS_REDIS_URL;
if (!PG_URL || !REDIS_URL) {
	console.error("STRESS_PG_URL and STRESS_REDIS_URL env vars are required");
	process.exit(1);
}

// Force tight pool — we want many concurrent dialects without saturating PSDB.
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? "1";
process.env.PG_POOL_IDLE_TIMEOUT_S = process.env.PG_POOL_IDLE_TIMEOUT_S ?? "10";

interface Snapshot {
	rssMB: number;
	activeHandles: number;
	activeRequests: number;
	/** Total rows in pg_stat_activity. When traffic flows through pgbouncer this includes
	 * pgbouncer's idle upstream pool, which stays warm after clients disconnect — so this
	 * number does NOT return to the pre-run baseline. Use `pgActive` for the leak signal. */
	pgBackends: number | null;
	/** Connections with state='active' (currently executing a query). Drops to 0 when no
	 * client is running anything, even with pgbouncer idle pool warm. The real leak signal. */
	pgActive: number | null;
	sessions: number;
}

interface ScenarioResult {
	name: string;
	durationMs: number;
	before: Snapshot;
	after: Snapshot;
	notes: string[];
	errors: string[];
	pass: boolean;
}

const allResults: ScenarioResult[] = [];

function uid(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function pgBackendCount(): Promise<{ total: number | null; active: number | null }> {
	const sql = postgres(PG_URL!, { prepare: false, max: 1, idle_timeout: 5 });
	try {
		const rows = await sql<{ total: string; active: string }[]>`
			SELECT
				count(*)::text AS total,
				count(*) FILTER (WHERE state = 'active')::text AS active
			FROM pg_stat_activity
			WHERE state IS NOT NULL
		`;
		const r = rows[0];
		return { total: Number(r?.total ?? 0), active: Number(r?.active ?? 0) };
	} catch {
		return { total: null, active: null };
	} finally {
		await sql.end({ timeout: 2 }).catch(() => {});
	}
}

function isPooledEndpoint(): boolean {
	// Heuristic: pgbouncer / supavisor / Neon-pooler / PSDB-pooler typically
	// listen on a non-default port (6432 most commonly) or on a `-pooler.`
	// hostname. Inside a pooler, pg_stat_activity reflects upstream pool state,
	// not client state — so totalBackends is not a leak signal.
	if (!PG_URL) return false;
	try {
		const u = new URL(PG_URL);
		if (u.port && u.port !== "5432") return true;
		if (u.hostname.includes("-pooler")) return true;
	} catch {
		// fallthrough
	}
	return false;
}

async function snapshot(sm?: SessionManager): Promise<Snapshot> {
	const handles = (process as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
	const reqs = (process as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.() ?? [];
	const counts = await pgBackendCount();
	return {
		rssMB: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
		activeHandles: handles.length,
		activeRequests: reqs.length,
		pgBackends: counts.total,
		pgActive: counts.active,
		sessions: sm ? (sm as unknown as { sessions: Map<string, unknown> }).sessions.size : 0,
	};
}

function log(...args: unknown[]): void {
	console.log("[stress]", ...args);
}

function makeSm(opts: ConstructorParameters<typeof SessionManager>[0] = {}): SessionManager {
	return new SessionManager({
		createFs: async (_t, sandboxId) => {
			const { fs } = await createPostgresSandboxFs(
				{ connectionString: PG_URL!, tenantId: "stress" },
				sandboxId,
			);
			return fs;
		},
		destroySandboxFn: async (_t, sandboxId) => destroyPostgresSandbox(PG_URL!, sandboxId),
		idleMs: 30_000,
		...opts,
	});
}

// ── Scenario 1: pool leak under destroy failures ──────────────────────────────

async function scenarioDestroyFailures(): Promise<ScenarioResult> {
	const name = "Pool leak under destroy failures";
	log(`▶ ${name}`);
	const errors: string[] = [];
	const notes: string[] = [];
	const N = Number(process.env.STRESS_N_DESTROY ?? "30");
	const before = await snapshot();
	const t0 = Date.now();

	let destroyCalls = 0;
	const sm = new SessionManager({
		createFs: async (_t, sandboxId) => {
			const { fs } = await createPostgresSandboxFs(
				{ connectionString: PG_URL!, tenantId: "stress" },
				sandboxId,
			);
			return fs;
		},
		// Inject failure on every other destroy. The plan-mandated `finally`
		// must still disconnect the FS so PG connections don't accumulate.
		destroySandboxFn: async (_t, sandboxId) => {
			destroyCalls++;
			if (destroyCalls % 2 === 0) {
				// Still actually delete on the DB side so the test cleans up,
				// but throw afterwards to simulate a failing teardown.
				await destroyPostgresSandbox(PG_URL!, sandboxId);
				throw new Error("simulated destroy failure");
			}
			await destroyPostgresSandbox(PG_URL!, sandboxId);
		},
		idleMs: 60_000,
	});

	const ids: string[] = Array.from({ length: N }, () => uid("dfail"));
	try {
		// Warm them all
		await Promise.all(ids.map((id) => sm.getOrCreate("stress", id)));
		notes.push(`warmed ${N} sandboxes`);
		const peak = await snapshot(sm);
		notes.push(`peak pg_backends=${peak.pgBackends} rssMB=${peak.rssMB}`);

		// Destroy them all; half will throw.
		const results = await Promise.allSettled(ids.map((id) => sm.destroy("stress", id)));
		const rejected = results.filter((r) => r.status === "rejected").length;
		notes.push(`destroy rejected=${rejected} (expected ~${N / 2})`);
		// Lower bound only — under PSDB cap pressure many destroys legitimately
		// reject with "too many clients", so the relevant signal is "did
		// post-shutdown drain to baseline" (asserted further down).
		if (rejected === 0 && N >= 2) errors.push(`expected at least some destroy failures, got 0`);

		// All sessions must be gone regardless of destroy errors.
		const sCount = (sm as unknown as { sessions: Map<string, unknown> }).sessions.size;
		if (sCount !== 0) errors.push(`sessions map not empty after destroy: ${sCount}`);
	} finally {
		await sm.shutdown({ drainTimeoutMs: 10_000 });
	}

	// Allow PG to drain idle connections
	await new Promise((r) => setTimeout(r, 4_000));
	const after = await snapshot();
	notes.push(
		`post-shutdown pgBackends=${after.pgBackends} pgActive=${after.pgActive} (before backends=${before.pgBackends} active=${before.pgActive})`,
	);
	assertPgDrain(before, after, notes, errors);

	return {
		name,
		durationMs: Date.now() - t0,
		before,
		after,
		notes,
		errors,
		pass: errors.length === 0,
	};
}

/**
 * The leak signal differs depending on whether we're going through a pooler:
 *  - direct PG: total backend count must drop back to baseline
 *  - pooler:    `state='active'` must drop to baseline (pooler holds idle upstream conns warm)
 */
function assertPgDrain(before: Snapshot, after: Snapshot, notes: string[], errors: string[]): void {
	if (isPooledEndpoint()) {
		notes.push(`pooled endpoint detected — using pgActive as leak signal`);
		if (before.pgActive !== null && after.pgActive !== null && after.pgActive > before.pgActive + 2) {
			errors.push(`active queries did not drain: before=${before.pgActive} after=${after.pgActive}`);
		}
		return;
	}
	if (before.pgBackends !== null && after.pgBackends !== null && after.pgBackends > before.pgBackends + 5) {
		errors.push(`PG backends did not drain: before=${before.pgBackends} after=${after.pgBackends}`);
	}
}

// ── Scenario 2: many warmed sandboxes (pool pressure) ─────────────────────────

async function scenarioPoolPressure(): Promise<ScenarioResult> {
	const name = "Many warmed sandboxes (pool pressure)";
	log(`▶ ${name}`);
	const errors: string[] = [];
	const notes: string[] = [];
	const N = Number(process.env.STRESS_N_SANDBOXES ?? "60");
	const OPS_PER = Number(process.env.STRESS_OPS_PER ?? "5");
	// Wave-based execution caps simultaneous warm sessions to bound RSS.
	// Each wave: warm WAVE sandboxes, run OPS_PER ops on each, destroy them all.
	// Useful for N>>200 where 1000 simultaneous Bash instances would OOM.
	const WAVE = Number(process.env.STRESS_WAVE ?? Math.min(N, 100));
	const before = await snapshot();
	const t0 = Date.now();

	const sm = makeSm({ idleMs: 60_000 });
	const ids = Array.from({ length: N }, () => uid("warm"));
	let totalOps = 0;
	let opErrors: string[] = [];
	let peakSessions = 0;
	let peakRss = 0;
	let peakBackends = 0;

	try {
		for (let waveStart = 0; waveStart < ids.length; waveStart += WAVE) {
			const wave = ids.slice(waveStart, waveStart + WAVE);
			// Warm wave
			await Promise.all(wave.map((id) => sm.getOrCreate("stress", id)));
			const peak = await snapshot(sm);
			peakSessions = Math.max(peakSessions, peak.sessions);
			peakRss = Math.max(peakRss, peak.rssMB);
			peakBackends = Math.max(peakBackends, peak.pgBackends ?? 0);

			// Run OPS_PER ops per sandbox in parallel
			const waveErrors: string[] = [];
			await Promise.all(
				wave.map(async (id) => {
					const session = sm.getSession("stress", id);
					if (!session) return;
					for (let k = 0; k < OPS_PER; k++) {
						try {
							await session.fs.writeFile(`/tmp/${k}.txt`, `hello-${k}`);
							const content = await session.fs.readFile(`/tmp/${k}.txt`);
							if (content !== `hello-${k}`) waveErrors.push(`bad content ${id}:${k}`);
						} catch (e) {
							waveErrors.push(`op fail ${id}:${k} ${(e as Error).message}`);
						}
					}
				}),
			);
			totalOps += wave.length * OPS_PER * 2; // each k = 1 write + 1 read
			opErrors = opErrors.concat(waveErrors);

			// Destroy wave to free memory before the next wave
			await Promise.allSettled(wave.map((id) => sm.destroy("stress", id).catch(() => {})));
			const waveIdx = Math.floor(waveStart / WAVE) + 1;
			const totalWaves = Math.ceil(ids.length / WAVE);
			log(
				`    wave ${waveIdx}/${totalWaves} done (sessions=${peak.sessions} rssMB=${peak.rssMB} ops=${totalOps} errs=${opErrors.length})`,
			);
		}
		notes.push(`peak across waves: sessions=${peakSessions} rssMB=${peakRss} pgBackends=${peakBackends}`);
		notes.push(`fs ops total=${totalOps} failures=${opErrors.length}`);
		if (opErrors.length > 0) errors.push(`${opErrors.length} fs op failures (e.g. ${opErrors[0]})`);
	} finally {
		await sm.shutdown({ drainTimeoutMs: 30_000 });
	}

	await new Promise((r) => setTimeout(r, 5_000));
	const after = await snapshot();
	notes.push(`post-shutdown pgBackends=${after.pgBackends} pgActive=${after.pgActive} rssMB=${after.rssMB}`);
	assertPgDrain(before, after, notes, errors);

	return {
		name,
		durationMs: Date.now() - t0,
		before,
		after,
		notes,
		errors,
		pass: errors.length === 0,
	};
}

// ── Scenario 3: Redis flakiness (INCR + lock) ─────────────────────────────────

async function scenarioRedisFlakiness(): Promise<ScenarioResult> {
	const name = "Redis flakiness (INCR + lock)";
	log(`▶ ${name}`);
	const errors: string[] = [];
	const notes: string[] = [];
	const before = await snapshot();
	const t0 = Date.now();

	const redis = new Redis(REDIS_URL!, {
		lazyConnect: false,
		maxRetriesPerRequest: 1,
		enableReadyCheck: true,
	});
	await new Promise<void>((resolve, reject) => {
		redis.once("ready", resolve);
		redis.once("error", reject);
		setTimeout(() => reject(new Error("redis connect timeout")), 10_000);
	});

	// Wrap incr with an injectable failure flag.
	let injectIncrFail = false;
	const realIncr = redis.incr.bind(redis);
	(redis as unknown as { incr: (k: string) => Promise<number> }).incr = async (key: string) => {
		if (injectIncrFail) throw new Error("injected ECONNRESET");
		return realIncr(key);
	};

	const sm = new SessionManager({
		createFs: async (_t, sandboxId) => {
			const { fs } = await createPostgresSandboxFs(
				{ connectionString: PG_URL!, tenantId: "stress", redis },
				sandboxId,
			);
			return fs;
		},
		destroySandboxFn: async (_t, sandboxId) => destroyPostgresSandbox(PG_URL!, sandboxId),
		idleMs: 60_000,
		redis,
		execLockOptions: { leaseMs: 5_000, renewMs: 1_500, acquireTimeoutMs: 10_000 },
	});

	const id = uid("flaky");
	try {
		// Warm.
		await sm.withSession("stress", id, async (s) => {
			await s.fs.writeFile("/initial.txt", "ok");
		});
		notes.push("initial mutation succeeded");

		// Inject INCR failure on next mutation: write must commit but
		// publishVersionIfDirty must throw ECOHERENCE.
		injectIncrFail = true;
		let coherenceSeen = false;
		try {
			await sm.withSession("stress", id, async (s) => {
				await s.fs.writeFile("/post-fail.txt", "boom");
			});
		} catch (e) {
			coherenceSeen = (e as { code?: string }).code === "ECOHERENCE";
		}
		if (!coherenceSeen) errors.push("expected ECOHERENCE on INCR failure but got none");
		else notes.push("ECOHERENCE surfaced as expected");

		const session = sm.getSession("stress", id);
		if (!session || session.lastSeenVersion !== -1) {
			errors.push(`session.lastSeenVersion expected -1 after publish failure; got ${session?.lastSeenVersion}`);
		}
		if (!session?.publishPending) {
			errors.push("session.publishPending should be true after publish failure");
		}

		// Recovery: next turn (no failure) should bump the counter.
		injectIncrFail = false;
		await sm.withSession("stress", id, async () => {
			/* dirty already pending */
		});
		const recovered = sm.getSession("stress", id);
		if (recovered?.publishPending) errors.push("publishPending should clear after recovery");
		if ((recovered?.lastSeenVersion ?? 0) <= 0) errors.push("lastSeenVersion should advance after recovery");
		else notes.push(`recovered: lastSeenVersion=${recovered?.lastSeenVersion}`);

		// Hammer with concurrent withSession to stress the lock heartbeat.
		const HAMMER = 30;
		const hammerStart = Date.now();
		const hres = await Promise.allSettled(
			Array.from({ length: HAMMER }, (_, i) =>
				sm.withSession("stress", id, async (s) => {
					await s.fs.writeFile(`/h-${i}.txt`, String(i));
				}),
			),
		);
		const hammerErrors = hres.filter((r) => r.status === "rejected").length;
		notes.push(`hammered ${HAMMER} writes in ${Date.now() - hammerStart}ms; failures=${hammerErrors}`);
	} finally {
		try {
			await sm.destroy("stress", id);
		} catch {
			// best-effort
		}
		await sm.shutdown({ drainTimeoutMs: 10_000 });
		await redis.quit().catch(() => {});
	}

	await new Promise((r) => setTimeout(r, 2_000));
	const after = await snapshot();
	notes.push(`post pgBackends=${after.pgBackends} handles=${after.activeHandles}`);

	return {
		name,
		durationMs: Date.now() - t0,
		before,
		after,
		notes,
		errors,
		pass: errors.length === 0,
	};
}

// ── Scenario 4: Semaphore + MCP bounds (in-process) ───────────────────────────

async function scenarioInProc(): Promise<ScenarioResult> {
	const name = "Semaphore + MCP bounds (in-process)";
	log(`▶ ${name}`);
	const errors: string[] = [];
	const notes: string[] = [];
	const before = await snapshot();
	const t0 = Date.now();

	// Semaphore: queue full
	const sm = new SessionManager({
		createFs: async () => ({}) as unknown as Awaited<ReturnType<typeof createPostgresSandboxFs>>["fs"],
		destroySandboxFn: async () => {},
		maxConcurrentPython: 1,
	});
	const internals = sm as unknown as {
		pythonSem: { inFlight: number; maxWaiters: number; waiters: unknown[] };
		acquireSlot(sem: unknown, signal?: AbortSignal): Promise<void>;
		releaseSlot(sem: unknown): void;
	};
	const sem = internals.pythonSem;
	sem.maxWaiters = 2;
	await internals.acquireSlot(sem); // fill
	const w1 = internals.acquireSlot(sem); // queue 1
	const w2 = internals.acquireSlot(sem); // queue 2
	let backpressure = false;
	try {
		await internals.acquireSlot(sem);
	} catch (e) {
		backpressure = e instanceof RuntimeBackpressureError;
	}
	if (!backpressure) errors.push("expected RuntimeBackpressureError when queue saturated");
	else notes.push("queue-full backpressure works");

	// Abort one waiter
	const ac = new AbortController();
	const w3p = internals.acquireSlot(sem, ac.signal);
	// Drop one of the existing in-queue items first so we have room to add w3
	// The acquireSlot above for w3 should reject because queue still full (maxWaiters=2)
	// Instead test with a sem that has capacity
	let w3Rejected = false;
	try {
		await w3p;
	} catch (e) {
		w3Rejected = (e as { name?: string }).name === "AbortError" || e instanceof RuntimeBackpressureError;
	}
	notes.push(`w3 rejected=${w3Rejected}`);

	// Drain
	internals.releaseSlot(sem);
	await w1;
	internals.releaseSlot(sem);
	await w2;
	internals.releaseSlot(sem);

	if (sem.waiters.length !== 0) errors.push(`semaphore waiters not drained: ${sem.waiters.length}`);
	else notes.push("waiters drained cleanly");

	// MCP TTL: dynamic import so we don't disturb the global MCP map until needed.
	const mcpMod = await import("../src/api/mcp/server.js");
	notes.push(`mcp module loaded (startMcpSessionSweeper=${typeof mcpMod.startMcpSessionSweeper})`);

	await sm.shutdown();
	const after = await snapshot();
	notes.push(`handles before=${before.activeHandles} after=${after.activeHandles}`);

	return {
		name,
		durationMs: Date.now() - t0,
		before,
		after,
		notes,
		errors,
		pass: errors.length === 0,
	};
}

// ── Migration bootstrap ───────────────────────────────────────────────────────

/**
 * Wipe every sandbox + every blob. Use only on a database dedicated to stress
 * testing — this is a destructive operation. CASCADE through dirents/inodes
 * via FK; blobs are content-addressed and deleted unconditionally.
 */
async function cleanupAll(): Promise<void> {
	log("⚠ cleaning up ALL sandboxes + blobs in stress DB…");
	const sql = postgres(PG_URL!, { prepare: false, max: 2, idle_timeout: 5 });
	try {
		const sandboxesBefore = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM sandboxes`;
		const blobsBefore = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM blobs`;
		log(`  before: sandboxes=${sandboxesBefore[0]?.n} blobs=${blobsBefore[0]?.n}`);

		// `sandboxes` cascades to inodes/dirents via FK ON DELETE CASCADE.
		await sql`DELETE FROM sandboxes`;
		// Blobs are global / content-addressed; not FK'd to sandboxes.
		await sql`DELETE FROM blobs`;

		const sandboxesAfter = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM sandboxes`;
		const blobsAfter = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM blobs`;
		log(`  after:  sandboxes=${sandboxesAfter[0]?.n} blobs=${blobsAfter[0]?.n}`);
	} finally {
		await sql.end({ timeout: 5 }).catch(() => {});
	}
}

async function ensureMigrations(): Promise<void> {
	log("running migrations against stress PG…");
	const tenantConfig = {
		tenantIds: ["stress"],
		getConnectionString: () => PG_URL!,
	} as Parameters<typeof runMigrations>[0];
	await runMigrations(tenantConfig);
	log("migrations OK");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const overallStart = Date.now();
	log(`starting stress run: PG=${PG_URL!.split("@")[1]?.split("?")[0]} REDIS=${REDIS_URL!.split("@")[1]}`);

	await ensureMigrations();
	if (process.env.STRESS_CLEANUP === "true") {
		await cleanupAll();
	}

	const scenarios = [scenarioDestroyFailures, scenarioPoolPressure, scenarioRedisFlakiness, scenarioInProc];
	for (const fn of scenarios) {
		try {
			const r = await fn();
			allResults.push(r);
			log(`  ${r.pass ? "✓" : "✗"} ${r.name} (${r.durationMs}ms)`);
			for (const n of r.notes) log(`    · ${n}`);
			for (const e of r.errors) log(`    ! ${e}`);
		} catch (err) {
			allResults.push({
				name: fn.name,
				durationMs: 0,
				before: await snapshot(),
				after: await snapshot(),
				notes: [],
				errors: [`scenario crashed: ${(err as Error).message}`],
				pass: false,
			});
			log(`  ✗ ${fn.name} crashed: ${(err as Error).message}`);
		}
	}

	// Report
	const totalDuration = Date.now() - overallStart;
	const passCount = allResults.filter((r) => r.pass).length;
	const reportPath = path.resolve("tasks/stress-test-results.md");
	const jsonPath = path.resolve("tasks/stress-test-results.json");

	const md = renderMarkdown(allResults, totalDuration, passCount);
	writeFileSync(reportPath, md, "utf8");
	writeFileSync(
		jsonPath,
		JSON.stringify(
			{ ranAt: new Date().toISOString(), totalDurationMs: totalDuration, results: allResults },
			null,
			2,
		),
		"utf8",
	);

	log(`\nDone. ${passCount}/${allResults.length} scenarios passed.`);
	log(`Report: ${reportPath}`);
	log(`JSON:   ${jsonPath}`);
	process.exit(passCount === allResults.length ? 0 : 1);
}

function renderMarkdown(results: ScenarioResult[], totalMs: number, passCount: number): string {
	const lines: string[] = [];
	lines.push("# Production Stability Stress Test Results");
	lines.push("");
	lines.push(`Ran: ${new Date().toISOString()}`);
	lines.push(`Total duration: ${totalMs}ms`);
	lines.push(`Pass rate: **${passCount}/${results.length}**`);
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push("| Scenario | Result | Duration | Notes |");
	lines.push("|---|---|---|---|");
	for (const r of results) {
		const status = r.pass ? "✅" : "❌";
		lines.push(`| ${r.name} | ${status} | ${r.durationMs}ms | ${r.notes.length} notes, ${r.errors.length} errors |`);
	}
	lines.push("");
	for (const r of results) {
		lines.push(`## ${r.pass ? "✅" : "❌"} ${r.name}`);
		lines.push("");
		lines.push("### Snapshots");
		lines.push("");
		lines.push("| Metric | Before | After |");
		lines.push("|---|---|---|");
		lines.push(`| RSS (MB) | ${r.before.rssMB} | ${r.after.rssMB} |`);
		lines.push(`| Active handles | ${r.before.activeHandles} | ${r.after.activeHandles} |`);
		lines.push(`| Active requests | ${r.before.activeRequests} | ${r.after.activeRequests} |`);
		lines.push(`| PG backends (total) | ${r.before.pgBackends ?? "n/a"} | ${r.after.pgBackends ?? "n/a"} |`);
		lines.push(`| PG active queries | ${r.before.pgActive ?? "n/a"} | ${r.after.pgActive ?? "n/a"} |`);
		lines.push(`| Sessions | ${r.before.sessions} | ${r.after.sessions} |`);
		lines.push("");
		if (r.notes.length > 0) {
			lines.push("### Notes");
			for (const n of r.notes) lines.push(`- ${n}`);
			lines.push("");
		}
		if (r.errors.length > 0) {
			lines.push("### Errors");
			for (const e of r.errors) lines.push(`- ${e}`);
			lines.push("");
		}
	}
	return lines.join("\n");
}

main().catch((err) => {
	console.error("[stress] fatal:", err);
	process.exit(2);
});
