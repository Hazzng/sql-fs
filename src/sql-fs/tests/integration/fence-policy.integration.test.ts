import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bulkIngest } from "../../dialects/postgres/ingest.js";
import { PostgresNamespace } from "../../dialects/postgres/namespace.js";
import {
	compositeFenceAndAdvance,
	fenceAndAdvance,
	PostgresSandbox,
	takeWriterLock,
} from "../../dialects/postgres/sandbox.js";
import type { PgTx } from "../../dialects/postgres/types.js";
import { requireMigratedSchema } from "./helpers/schema-preconditions.js";

const SKIP = !process.env.DATABASE_URL;

type Seeded = { id: string; rootInodeId: bigint };
type Entry = { parent: string; name: string; inode: string };
type Inode = { id: string; nlink: number; mode: number; sha: string | null };
type Snapshot = { version: string; entries: Entry[] | null; inodes: Inode[] | null };
type Isolation = "read committed" | "repeatable read";
type Contenders = { holderPid: number; waiterPid: number };
type LockObservation = { blocked: boolean; matching_lock: boolean };

describe.skipIf(SKIP)("sandbox fence policy", () => {
	let recording: string[] | undefined;
	const sql = postgres(process.env.DATABASE_URL ?? "postgres://unused", {
		prepare: false,
		max: 4,
		debug(_connection, query) {
			recording?.push(query.replace(/\s+/g, " ").trim());
		},
	});
	const sandbox = new PostgresSandbox();
	let backfills = 0;
	const namespace = new PostgresNamespace({
		backfill() {
			backfills++;
		},
	});
	const ids: string[] = [];
	const sha = new Uint8Array(randomBytes(32));
	const data = new Uint8Array([65]);

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL!);
		const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
			SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
		`;
		expect(role, "run against an ordinary application role such as sqlfs_app; RLS proofs need it").toEqual({
			rolsuper: false,
			rolbypassrls: false,
		});
		await sql`INSERT INTO blobs (sha256, data, size) VALUES (${sha}, ${data}, 1) ON CONFLICT (sha256) DO NOTHING`;
	});

	afterAll(async () => {
		recording = undefined;
		for (const id of ids) {
			await sql.begin(async (tx) => {
				await sandbox.deleteSandbox(tx, id);
				await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
			});
		}
		await sql`
			DELETE FROM blobs
			WHERE sha256 = ${sha} AND NOT EXISTS (SELECT 1 FROM inodes WHERE content_sha256 = ${sha})
		`;
		await sql.end();
	});

	async function create(label: string): Promise<Seeded> {
		const id = `fence-policy-${label}-${randomUUID()}`;
		ids.push(id);
		const created = await sql.begin((tx) => sandbox.createSandbox(tx, id));
		return { id, rootInodeId: created.rootInodeId };
	}

	function snapshot(s: Seeded): Promise<Snapshot> {
		return sql.begin(async (tx) => {
			await sandbox.setSandboxContext(tx, s.id);
			const [row] = await tx<Snapshot[]>`
				SELECT version::text,
					(SELECT jsonb_agg(jsonb_build_object('parent', parent_inode_id::text, 'name', name, 'inode', inode_id::text)
						ORDER BY parent_inode_id, name) FROM dirents WHERE sandbox_id = ${s.id}) AS entries,
					(SELECT jsonb_agg(jsonb_build_object(
						'id', id::text, 'nlink', nlink, 'mode', mode, 'sha', encode(content_sha256, 'hex')
					) ORDER BY id) FROM inodes WHERE sandbox_id = ${s.id}) AS inodes
				FROM sandboxes WHERE id = ${s.id}
			`;
			return row!;
		});
	}

	async function executed<T>(
		run: () => Promise<T>,
	): Promise<{ statements: string[]; result?: T; error?: unknown; code?: string }> {
		const statements: string[] = [];
		recording = statements;
		try {
			return { statements, result: await run() };
		} catch (error) {
			return { statements, error, code: (error as { code?: string }).code };
		} finally {
			recording = undefined;
		}
	}

	async function linkAlias(tx: PgTx, s: Seeded, target: string, alias: string): Promise<void> {
		await sandbox.setSandboxContextWithLock(tx, s.id);
		const [row] = await tx<{ inode_id: string }[]>`
			SELECT inode_id FROM dirents WHERE parent_inode_id = ${String(s.rootInodeId)} AND name = ${target}
		`;
		const inodeId = BigInt(row!.inode_id);
		await namespace.incrementNlink(tx, inodeId, s.id);
		await namespace.insertDirent(tx, s.rootInodeId, alias, inodeId);
	}

	it("dispatches one lock and one fenced statement per composite, and two pairs per move", async () => {
		const s = await create("counts");
		const backfillsBefore = backfills;
		const counts = await sql.begin(async (tx) => {
			const mkdir = await executed(() => namespace.mkdirComposite(tx, s.id, s.rootInodeId, "source", 0o755, 0n));
			const write = await executed(() =>
				namespace.writeFileComposite(tx, s.id, s.rootInodeId, "file", 0o644, 1, sha, data, 1n),
			);
			const destination = await executed(() =>
				namespace.mkdirComposite(tx, s.id, s.rootInodeId, "destination", 0o755, 2n),
			);
			const move = await executed(() =>
				namespace.mvComposite(tx, s.id, s.rootInodeId, "source", s.rootInodeId, "destination", 3n),
			);
			const rm = await executed(() => namespace.rmComposite(tx, s.id, s.rootInodeId, "file", 5n));
			return { mkdir, write, destination, move, rm };
		});
		for (const outcome of Object.values(counts)) expect(outcome.error).toBeUndefined();
		expect(
			Object.fromEntries(Object.entries(counts).map(([name, outcome]) => [name, outcome.statements.length])),
		).toEqual({ mkdir: 2, write: 2, destination: 2, move: 4, rm: 2 });
		const lock = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";
		expect(counts.move.statements[0]).toBe(lock);
		expect(counts.move.statements[1]).toMatch(/^WITH ctx AS \( SELECT set_config\('app\.sandbox_id', \$1, true\),/);
		expect(counts.move.statements[2]).toBe(lock);
		expect(counts.move.statements[3]).toMatch(/^WITH ctx AS \( SELECT set_config\('app\.sandbox_id', \$1, true\),/);
		expect(backfills - backfillsBefore).toBe(1);
		const after = await snapshot(s);
		expect(after.version).toBe("6");
	});

	it("leaves every composite's writes unreachable when a caught ESTALE is committed", async () => {
		const s = await create("stale-commit");
		await sql.begin(async (tx) => {
			await namespace.mkdirComposite(tx, s.id, s.rootInodeId, "directory", 0o755, 0n);
			await namespace.writeFileComposite(tx, s.id, s.rootInodeId, "linked", 0o644, 1, sha, data, 1n);
		});
		await sql.begin((tx) => linkAlias(tx, s, "linked", "alias"));
		const before = await snapshot(s);
		expect(before.version).toBe("3");
		const backfillsBefore = backfills;

		const outcomes = await sql.begin(async (tx) => {
			await sandbox.setSandboxContext(tx, s.id);
			return [
				await executed(() => namespace.mkdirComposite(tx, s.id, s.rootInodeId, "stale", 0o755, 2n)),
				await executed(() => namespace.rmComposite(tx, s.id, s.rootInodeId, "alias", 2n)),
				await executed(() => namespace.writeFileComposite(tx, s.id, s.rootInodeId, "linked", 0o644, 1, sha, data, 2n)),
				await executed(() => namespace.mvComposite(tx, s.id, s.rootInodeId, "directory", s.rootInodeId, "alias", 2n)),
			];
		});

		expect(outcomes.map((outcome) => outcome.code)).toEqual(["ESTALE", "ESTALE", "ESTALE", "ESTALE"]);
		expect(outcomes.map((outcome) => outcome.statements.length)).toEqual([2, 2, 2, 2]);
		expect(backfills).toBe(backfillsBefore);
		expect(await snapshot(s)).toEqual(before);
	});

	it("leaves existing-context and ingest writes unreachable when a caught ESTALE is committed", async () => {
		const s = await create("stale-existing");
		await sql.begin((tx) => namespace.mkdirComposite(tx, s.id, s.rootInodeId, "directory", 0o755, 0n));
		const before = await snapshot(s);
		let batches = 0;

		const outcomes = await sql.begin(async (tx) => {
			await sandbox.setSandboxContext(tx, s.id);
			return [
				await executed(() => namespace.createInode(tx, { sandboxId: s.id, kind: 1, mode: 0o644, size: 0 }, 0n)),
				await executed(() =>
					bulkIngest(tx, [{ path: "/ingested.txt", content: data, mode: 0o644 }], s.id, 0n, {
						async commitBatch() {
							batches++;
						},
					}),
				),
			];
		});

		expect(outcomes.map((outcome) => outcome.code)).toEqual(["ESTALE", "ESTALE"]);
		expect(outcomes.map((outcome) => outcome.statements.length)).toEqual([1, 1]);
		expect(batches).toBe(0);
		expect(await snapshot(s)).toEqual(before);
	});

	it("advances once per lower-level fenced mutation in its single statement", async () => {
		const s = await create("existing");
		const outcome = await sql.begin(async (tx) => {
			await sandbox.setSandboxContextWithLock(tx, s.id);
			return executed(() => namespace.createInode(tx, { sandboxId: s.id, kind: 2, mode: 0o755, size: 0 }, 0n));
		});
		expect(outcome.error).toBeUndefined();
		expect(outcome.statements).toHaveLength(1);
		expect(outcome.statements[0]).toMatch(/^WITH ctx AS \( SELECT s\.version FROM sandboxes s WHERE s\.id = \$1/);
		expect((await snapshot(s)).version).toBe("1");
	});

	it("falls back to the transaction-local epoch and scopes RLS when no epoch or context is set", async () => {
		const s = await create("undefined-epoch");
		const settings = await sql.begin(async (tx) => {
			await namespace.mkdirComposite(tx, s.id, s.rootInodeId, "first", 0o755);
			await namespace.mkdirComposite(tx, s.id, s.rootInodeId, "second", 0o755);
			const [row] = await tx<{ epoch: string; context: string }[]>`
				SELECT current_setting('app.sandbox_epoch') AS epoch, current_setting('app.sandbox_id') AS context
			`;
			return row!;
		});
		expect(settings).toEqual({ epoch: "2", context: s.id });
		expect((await snapshot(s)).version).toBe("2");
	});

	it("refuses a composite for another sandbox and keeps the active RLS context", async () => {
		const active = await create("active");
		const target = await create("target");
		const before = await snapshot(target);
		const outcome = await sql.begin(async (tx) => {
			await sandbox.setSandboxContext(tx, active.id);
			const call = await executed(() =>
				namespace.mkdirComposite(tx, target.id, target.rootInodeId, "cross", 0o755, 0n),
			);
			const [row] = await tx<{ id: string }[]>`SELECT current_setting('app.sandbox_id') AS id`;
			return { call, context: row!.id };
		});
		expect(outcome.call.error).toBeInstanceOf(Error);
		expect((outcome.call.error as Error).message).toBe("mkdirComposite: INSERT returned no rows");
		expect(outcome.call.statements).toHaveLength(2);
		expect(outcome.context).toBe(active.id);
		expect(await snapshot(target)).toEqual(before);
	});

	it("keeps link counts when rm and move drop one name of a hardlinked inode", async () => {
		const s = await create("hardlink");
		await sql.begin(async (tx) => {
			await namespace.writeFileComposite(tx, s.id, s.rootInodeId, "linked", 0o644, 1, sha, data, 0n);
			await namespace.writeFileComposite(tx, s.id, s.rootInodeId, "other", 0o644, 1, sha, data, 1n);
		});
		await sql.begin((tx) => linkAlias(tx, s, "linked", "alias"));
		const inodeOf = (snap: Snapshot, name: string): string => snap.entries!.find((entry) => entry.name === name)!.inode;
		const nlinkOf = (snap: Snapshot, id: string): number | undefined =>
			snap.inodes!.find((inode) => inode.id === id)?.nlink;
		const seeded = await snapshot(s);
		const shared = inodeOf(seeded, "linked");
		const other = inodeOf(seeded, "other");
		expect(nlinkOf(seeded, shared)).toBe(2);

		await sql.begin((tx) => namespace.rmComposite(tx, s.id, s.rootInodeId, "alias", 3n));
		const afterRm = await snapshot(s);
		expect(nlinkOf(afterRm, shared)).toBe(1);

		await sql.begin((tx) => linkAlias(tx, s, "linked", "alias"));
		await sql.begin((tx) => namespace.mvComposite(tx, s.id, s.rootInodeId, "other", s.rootInodeId, "alias", 5n));
		const afterMove = await snapshot(s);
		expect(nlinkOf(afterMove, shared)).toBe(1);
		expect(inodeOf(afterMove, "alias")).toBe(other);
		expect(inodeOf(afterMove, "linked")).toBe(shared);
		expect(afterMove.version).toBe("7");

		await sql.begin((tx) => namespace.mvComposite(tx, s.id, s.rootInodeId, "alias", s.rootInodeId, "linked", 7n));
		const afterReplace = await snapshot(s);
		expect(nlinkOf(afterReplace, shared)).toBeUndefined();
		expect(inodeOf(afterReplace, "linked")).toBe(other);
		expect(afterReplace.version).toBe("9");
	});

	async function observeBlocker({ holderPid, waiterPid }: Contenders): Promise<void> {
		const deadline = Date.now() + 10_000;
		let observed: LockObservation | undefined;
		do {
			observed = await sql.begin(async (tx) => {
				await tx`SET LOCAL statement_timeout = '1s'`;
				const [row] = await tx<LockObservation[]>`
					SELECT ${holderPid} = ANY(pg_blocking_pids(${waiterPid})) AS blocked,
						EXISTS (
							SELECT 1 FROM pg_locks holder JOIN pg_locks waiter
								ON holder.database = waiter.database AND holder.classid = waiter.classid
								AND holder.objid = waiter.objid AND holder.objsubid = waiter.objsubid
							WHERE holder.pid = ${holderPid} AND waiter.pid = ${waiterPid}
								AND holder.locktype = 'advisory' AND waiter.locktype = 'advisory'
								AND holder.granted AND NOT waiter.granted
						) AS matching_lock
				`;
				return row;
			});
			if (observed?.blocked && observed.matching_lock) return;
			await pause(25);
		} while (Date.now() < deadline);
		throw new Error(`advisory lock wait not observed: ${JSON.stringify({ holderPid, waiterPid, observed })}`);
	}

	async function runContendedFence(
		s: Seeded,
		isolation: Isolation,
		expectedEpoch: bigint,
		observe: (contenders: Contenders) => Promise<void> = observeBlocker,
	): Promise<PromiseSettledResult<void>> {
		const release = deferred<void>();
		const holderReady = deferred<number>();
		const waiterReady = deferred<number>();
		const tasks: Promise<PromiseSettledResult<void>>[] = [];
		try {
			const holder = settled(
				sql.begin(async (tx) => {
					await tx`SET LOCAL statement_timeout = '10s'`;
					await takeWriterLock(tx, s.id);
					const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
					expect(row).toBeDefined();
					holderReady.resolve(row!.pid);
					await release.promise;
					await namespace.mkdirComposite(tx, s.id, s.rootInodeId, "holder", 0o755, 0n);
				}),
			);
			tasks.push(holder);
			const holderPid = await readyPid(holderReady.promise, holder);
			const waiter = settled(
				sql.begin(`isolation level ${isolation}`, async (tx) => {
					await tx`SET LOCAL statement_timeout = '10s'`;
					await sandbox.setSandboxContext(tx, s.id);
					const [row] = await tx<{ pid: number; version: string; isolation: string }[]>`
						SELECT pg_backend_pid() AS pid, version::text,
							current_setting('transaction_isolation') AS isolation FROM sandboxes WHERE id = ${s.id}
					`;
					expect(row).toMatchObject({ version: "0", isolation });
					waiterReady.resolve(row!.pid);
					await namespace.mkdirComposite(tx, s.id, s.rootInodeId, "waiter", 0o755, expectedEpoch);
				}),
			);
			tasks.push(waiter);
			const waiterPid = await readyPid(waiterReady.promise, waiter);
			await observe({ holderPid, waiterPid });
			release.resolve();
			const holderOutcome = await holder;
			if (holderOutcome.status === "rejected") throw holderOutcome.reason;
			return await waiter;
		} finally {
			release.resolve();
			await Promise.all(tasks);
		}
	}

	it.each([
		{ isolation: "read committed", pin: 0n, verdict: "ESTALE", version: "1" },
		{ isolation: "read committed", pin: 1n, verdict: "accepted", version: "2" },
		{ isolation: "repeatable read", pin: 0n, verdict: "40001", version: "1" },
		{ isolation: "repeatable read", pin: 1n, verdict: "ESTALE", version: "1" },
	] satisfies { isolation: Isolation; pin: bigint; verdict: string; version: string }[])(
		"applies $verdict under $isolation with snapshot 0 and pin $pin after an observed lock wait",
		async ({ isolation, pin, verdict, version }) => {
			const s = await create(`lock-${isolation}-${pin}`);
			const outcome = await runContendedFence(s, isolation, pin);
			if (verdict === "accepted") {
				expect(outcome.status).toBe("fulfilled");
			} else {
				expect(outcome).toMatchObject({ status: "rejected", reason: { code: verdict } });
			}
			const after = await snapshot(s);
			expect(after.version).toBe(version);
			const names = after.entries!.map((entry) => entry.name);
			expect(names).toContain("holder");
			expect(names.includes("waiter")).toBe(verdict === "accepted");
		},
	);

	it("drains both transactions after an observer failure and makes their connections reusable", async () => {
		const s = await create("observer-failure");
		const failure = new Error("injected observer failure");
		const pids: number[] = [];
		await expect(
			runContendedFence(s, "read committed", 0n, async (contenders) => {
				await observeBlocker(contenders);
				pids.push(contenders.holderPid, contenders.waiterPid);
				throw failure;
			}),
		).rejects.toBe(failure);
		const connections = await Promise.all(Array.from({ length: 4 }, () => sql.reserve()));
		try {
			const reused = await Promise.all(
				connections.map(async (connection) => {
					const [row] = await connection<{ pid: number; advisory_locks: number }[]>`
						SELECT pg_backend_pid() AS pid,
							(SELECT count(*)::int FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory') AS advisory_locks
					`;
					return row;
				}),
			);
			expect(pids).toHaveLength(2);
			for (const pid of pids) expect(reused).toContainEqual({ pid, advisory_locks: 0 });
		} finally {
			for (const connection of connections) connection.release();
		}
		const after = await snapshot(s);
		expect(after.version).toBe("1");
		const names = after.entries!.map((entry) => entry.name);
		expect(names).toContain("holder");
		expect(names).not.toContain("waiter");
	});

	it.each([
		["existing", fenceAndAdvance],
		["composite", compositeFenceAndAdvance],
	])("builds the %s fence fragment without dispatching a statement", async (label, build) => {
		const s = await create(`lazy-${label}`);
		const outcome = await sql.begin(async (tx) => {
			const statements: string[] = [];
			recording = statements;
			try {
				const fragment = build(tx, s.id, 0n);
				await Promise.resolve();
				await new Promise((resolve) => setImmediate(resolve));
				const afterConstruction = statements.length;
				await takeWriterLock(tx, s.id);
				const [row] = await tx<{ fenced: number }[]>`WITH ${fragment} SELECT count(*)::int AS fenced FROM epoch`;
				return { afterConstruction, afterStatement: statements.length, fenced: row!.fenced };
			} finally {
				recording = undefined;
			}
		});
		expect(outcome).toEqual({ afterConstruction: 0, afterStatement: 2, fenced: 1 });
	});
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function settled(task: Promise<void>): Promise<PromiseSettledResult<void>> {
	return task.then(
		(value) => ({ status: "fulfilled", value }),
		(reason: unknown) => ({ status: "rejected", reason }),
	);
}

function readyPid(pid: Promise<number>, task: Promise<PromiseSettledResult<void>>): Promise<number> {
	return Promise.race([
		pid,
		task.then((outcome) => {
			if (outcome.status === "rejected") throw outcome.reason;
			throw new Error("contender completed before reporting its backend PID");
		}),
	]);
}
