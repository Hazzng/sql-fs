/**
 * #166 against a real Postgres: a script scope no longer pins a server connection.
 *
 * The oracle is `pg_stat_activity`, read from a SEPARATE connection while a script
 * is mid-flight: `max(now() - xact_start) WHERE state = 'idle in transaction'` IS
 * #166's exposure, in seconds. A test that only checked the resulting tree would
 * pass identically under both shapes, so both shapes are run here and compared.
 *
 * Skipped when DATABASE_URL is not set so unit-only runs stay useful.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";
import { requireMigratedSchema } from "./helpers/schema-preconditions.js";

const SKIP = !process.env.DATABASE_URL;
const BUFFER_ON = { enabled: true, maxOps: 50_000, maxBytes: 32 * 1024 * 1024 } as const;

/** Adds `application_name` to a Postgres URL so a suite can identify its own backends. */
function taggedUrl(base: string, appName: string): string {
	const u = new URL(base);
	u.searchParams.set("application_name", appName);
	return u.toString();
}

function uniqueId(label: string): string {
	return `buf166-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

describe.skipIf(SKIP)("#166 — buffered script-tx against Postgres", () => {
	/**
	 * Every connection this suite opens is tagged, so the idle-in-transaction probe
	 * and the reap below can be scoped to our own backends. Unscoped they read and
	 * kill every backend on the database — which on a shared DATABASE_URL means a
	 * dev server, the load-test harness or a parallel vitest worker.
	 */
	const APP_NAME = `sqlfs-buf166-${process.pid}`;
	const url = taggedUrl(process.env.DATABASE_URL!, APP_NAME);
	const dialect = new PostgresDialect(url);
	/** Observer connection: must be outside the dialect pool or it competes for it. */
	const observer = postgres(url, { prepare: false, max: 1 });
	const sandboxIds = new Set<string>();

	beforeAll(async () => {
		await requireMigratedSchema(url);
		await dialect.connect();
	});

	afterAll(async () => {
		for (const id of sandboxIds) {
			try {
				await dialect.transaction((tx) => dialect.deleteSandbox(tx, id));
			} catch {
				// Best effort — a failed test may already have removed the row.
			}
		}
		await dialect.disconnect();
		await observer.end();
	});

	async function newFs(label: string, buffered: boolean): Promise<{ fs: SqlFs; id: string }> {
		const id = uniqueId(label);
		sandboxIds.add(id);
		await dialect.transaction((tx) => dialect.createSandbox(tx, id));
		const fs = new SqlFs({ dialect, sandboxId: id, ...(buffered ? { scriptTxBuffer: BUFFER_ON } : {}) });
		await fs.ready();
		return { fs, id };
	}

	/**
	 * Oldest open transaction belonging to THIS suite, in seconds.
	 *
	 * Scoped by `application_name`: an unqualified probe reads every backend on the
	 * database, so a dev server, the load-test harness or a parallel vitest worker
	 * sharing DATABASE_URL would make `toBe(0)` fail spuriously and could let the
	 * legacy `> 0.9` assertion pass on activity this suite never caused.
	 */
	async function maxIdleInTxAge(): Promise<number> {
		const rows = await observer<{ age: number; cnt: number }[]>`
			SELECT coalesce(max(extract(epoch FROM (now() - xact_start))), 0)::float8 AS age,
			       count(*)::int AS cnt
			FROM pg_stat_activity
			WHERE state = 'idle in transaction'
			  AND datname = current_database()
			  AND application_name = ${APP_NAME}
		`;
		return rows[0]!.cnt === 0 ? 0 : rows[0]!.age;
	}

	async function version(id: string): Promise<bigint> {
		const rows = await observer<{ version: string }[]>`SELECT version FROM sandboxes WHERE id = ${id}`;
		return BigInt(rows[0]!.version);
	}

	async function pathsInDb(id: string): Promise<string[]> {
		const rows = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, id);
			return dialect.loadAllPaths(tx);
		});
		return rows.map((r) => r.path).sort();
	}

	it("holds no transaction open across a script that pauses", async () => {
		const { fs, id } = await newFs("nopin", true);
		fs.beginScriptScope();
		await fs.writeFile("/f1", "a");
		// Stands in for `sleep 1` in the user's script.
		await new Promise((r) => setTimeout(r, 1000));
		const duringScript = await maxIdleInTxAge();
		await fs.writeFile("/f2", "b");
		await fs.endScriptScope();

		expect(duringScript).toBe(0);
		expect(await pathsInDb(id)).toContain("/f1");
	});

	it("legacy mode pins one for the whole script — the defect, measured", async () => {
		const { fs } = await newFs("pin", false);
		fs.beginScriptScope();
		await fs.writeFile("/f1", "a");
		await new Promise((r) => setTimeout(r, 1000));
		const duringScript = await maxIdleInTxAge();
		await fs.writeFile("/f2", "b");
		await fs.endScriptScope();

		expect(duringScript).toBeGreaterThan(0.9);
	});

	it("commits the whole script atomically", async () => {
		const { fs, id } = await newFs("atomic", true);
		fs.beginScriptScope();
		await fs.mkdir("/d");
		await fs.writeFile("/d/a.txt", "one");
		await fs.writeFile("/d/b.txt", "two");
		await fs.cp("/d", "/d2", { recursive: true });
		// Ordered before the read: under the legacy shape the read itself would block on
		// the advisory lock the open script-tx holds, so the pin has to be checked first
		// for this to fail rather than hang.
		expect(await maxIdleInTxAge()).toBe(0);
		expect(await pathsInDb(id)).toEqual(["/", "/bin", "/home", "/home/user", "/tmp"]);

		await fs.endScriptScope();
		expect(await pathsInDb(id)).toEqual([
			"/",
			"/bin",
			"/d",
			"/d/a.txt",
			"/d/b.txt",
			"/d2",
			"/d2/a.txt",
			"/d2/b.txt",
			"/home",
			"/home/user",
			"/tmp",
		]);
	});

	// Parity control: passes under BOTH shapes on purpose. An abort must still roll
	// everything back, which is the guarantee ELOCKLOST's "not committed" claim rests on.
	it("applies nothing when the scope aborts", async () => {
		const { fs, id } = await newFs("abort", true);
		const before = await version(id);
		fs.beginScriptScope();
		await fs.mkdir("/gone");
		await fs.writeFile("/gone/a.txt", "x");
		await fs.abortScriptScope();

		expect(await pathsInDb(id)).not.toContain("/gone");
		expect(await version(id)).toBe(before);
	});

	it("advances `sandboxes.version` exactly as the legacy shape does", async () => {
		// The per-command trace from #161/#204: fresh 0 → echo 1 → cp 2 → chmod 3 →
		// mkdir -p /x/y/z 6 → ln 7 → touch 8 → rm -r 11. One scope per step, as one
		// exec per command would produce.
		const trace = async (buffered: boolean): Promise<bigint[]> => {
			const { fs, id } = await newFs(buffered ? "trace-buf" : "trace-legacy", buffered);
			const seen: bigint[] = [await version(id)];
			const step = async (fn: () => Promise<void>): Promise<void> => {
				fs.beginScriptScope();
				await fn();
				await fs.endScriptScope();
				seen.push(await version(id));
			};
			await step(() => fs.writeFile("/a.txt", "hi"));
			await step(() => fs.cp("/a.txt", "/b.txt"));
			await step(() => fs.chmod("/b.txt", 0o600));
			await step(() => fs.mkdir("/x/y/z", { recursive: true }));
			await step(() => fs.link("/a.txt", "/c.txt"));
			await step(() => fs.utimes("/a.txt", new Date(), new Date()));
			await step(() => fs.rm("/x", { recursive: true }));
			return seen;
		};

		expect(await trace(true)).toEqual([0n, 1n, 2n, 3n, 6n, 7n, 8n, 11n]);
		expect(await trace(false)).toEqual([0n, 1n, 2n, 3n, 6n, 7n, 8n, 11n]);
	});

	it("rolls the whole script back when another writer moved the epoch mid-script", async () => {
		const { fs, id } = await newFs("stale", true);
		fs.beginScriptScope();
		await fs.writeFile("/mine.txt", "mine");
		// A second replica commits on this sandbox while our script runs.
		await observer`UPDATE sandboxes SET version = version + 1 WHERE id = ${id}`;

		await expect(fs.endScriptScope()).rejects.toMatchObject({ code: "ESTALE" });
		expect(await pathsInDb(id)).not.toContain("/mine.txt");
	});

	/**
	 * The harness's own acceptance criterion for #166, reduced to one process:
	 * "`pool_size == concurrency` no longer deadlocks — i.e. a write no longer needs
	 * two pool connections at once".
	 *
	 * A pool of exactly one makes the two-connection requirement fatal instead of
	 * merely expensive: the script-tx pins the only connection and the second write's
	 * `commitBlob` — deliberately on its OWN connection since F6 — waits for it
	 * forever. No PgBouncer needed; the mechanism is the same one a transaction
	 * pooler turns into a wedged replica at `default_pool_size` concurrent writers.
	 */
	describe("a write needs one pool connection, not two", () => {
		async function twoWriteScope(buffered: boolean, timeoutMs: number): Promise<"done" | "stuck"> {
			// `PG_POOL_MAX` is read once, inside `connect()`; restore it immediately after
			// so nothing else in the run inherits a pool of one.
			const previous = process.env.PG_POOL_MAX ?? "";
			process.env.PG_POOL_MAX = "1";
			const narrow = new PostgresDialect(url);
			try {
				await narrow.connect();
			} finally {
				process.env.PG_POOL_MAX = previous;
			}
			const id = uniqueId(buffered ? "pool-buf" : "pool-legacy");
			sandboxIds.add(id);
			await dialect.transaction((tx) => dialect.createSandbox(tx, id));
			const fs = new SqlFs({ dialect: narrow, sandboxId: id, ...(buffered ? { scriptTxBuffer: BUFFER_ON } : {}) });
			await fs.ready();

			const run = (async (): Promise<"done"> => {
				fs.beginScriptScope();
				await fs.writeFile("/one.txt", "1");
				await fs.writeFile("/two.txt", "2");
				await fs.endScriptScope();
				return "done";
			})();
			// The losing shape hangs rather than throwing, so the race is what turns it
			// into a failed assertion instead of a suite that never finishes.
			const outcome = await Promise.race([
				run.catch(() => "done" as const),
				new Promise<"stuck">((r) => setTimeout(() => r("stuck"), timeoutMs)),
			]);
			if (outcome === "stuck") {
				// The wedged script still owns a backend sitting `idle in transaction` — the
				// very state the rest of this suite asserts is absent. Reap it here rather
				// than letting it fail a later test: `abortScriptScope` cannot help, because
				// its own recovery reload wants the connection that is stuck.
				void run.catch(() => {});
				await observer`
					SELECT pg_terminate_backend(pid)
					FROM pg_stat_activity
					WHERE state = 'idle in transaction'
					  AND datname = current_database()
					  AND application_name = ${APP_NAME}
					  AND pid <> pg_backend_pid()
				`;
				void narrow.disconnect().catch(() => {});
			} else {
				await narrow.disconnect();
			}
			return outcome;
		}

		it("buffered: two writes in one scope finish on a pool of one", async () => {
			expect(await twoWriteScope(true, 5000)).toBe("done");
		});

		it("legacy: the same script wedges on a pool of one — the defect", async () => {
			expect(await twoWriteScope(false, 5000)).toBe("stuck");
		});
	});

	it("serves read-your-own-writes from cache without touching the database", async () => {
		const { fs } = await newFs("ryow", true);
		fs.beginScriptScope();
		await fs.writeFile("/r.txt", "content");
		expect(await fs.readFile("/r.txt")).toBe("content");
		await fs.appendFile("/r.txt", "-more");
		expect(await fs.readFile("/r.txt")).toBe("content-more");
		expect(await maxIdleInTxAge()).toBe(0);
		await fs.endScriptScope();
		expect(await fs.readFile("/r.txt")).toBe("content-more");
	});
});
