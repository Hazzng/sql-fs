/**
 * #192 against a real Postgres: every mutation advances `sandboxes.version` and
 * every one of them rejects a stale pin.
 *
 * `fencing.integration.test.ts` covers the four composites. These are the
 * fourteen call sites that reach the database some other way — `bulkIngest`,
 * `mkdir -p`, `rm -r`, `cp`, `cp -r`, `link`, `symlink`, `chmod`, `utimes`, and
 * the non-composite `writeFile`/`appendFile`/`mkdir`/`rm`/`mv` fallbacks — which
 * before this change neither fenced nor moved the counter. The second half was
 * the worse one: a live writer using only these left the counter where it was,
 * so the next genuinely stale writer's pin still matched.
 *
 * Skipped when DATABASE_URL is not set so unit-only runs stay useful.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";

const SKIP = !process.env.DATABASE_URL;

function uniqueId(label: string): string {
	return `fence192-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function destroySandbox(dialect: PostgresDialect, id: string): Promise<void> {
	try {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, id);
			await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
		});
	} catch {
		try {
			await dialect.transaction(async (tx) => {
				await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
			});
		} catch {
			// best effort
		}
	}
}

describe.skipIf(SKIP)("#192 — every mutation advances the sandbox epoch", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxIds = new Set<string>();

	beforeAll(async () => {
		await dialect.connect();
	});

	afterAll(async () => {
		for (const id of sandboxIds) await destroySandbox(dialect, id);
		await dialect.disconnect();
	});

	async function newFs(label: string): Promise<{ fs: SqlFs; id: string; rootInodeId: bigint }> {
		const id = uniqueId(label);
		sandboxIds.add(id);
		const created = await dialect.transaction((tx) => dialect.createSandbox(tx, id));
		const fs = new SqlFs({ dialect, sandboxId: id, allowSymlinks: true });
		await fs.ready();
		return { fs, id, rootInodeId: created.rootInodeId };
	}

	async function version(id: string): Promise<bigint> {
		const rows = await dialect.transaction(
			(tx) => tx<{ version: string }[]>`SELECT version FROM sandboxes WHERE id = ${id}`,
		);
		return BigInt(rows[0]!.version);
	}

	it("moves sandboxes.version for each non-composite shell mutation", async () => {
		const { fs, id } = await newFs("advance");
		await fs.writeFile("/home/user/a.txt", "one");

		const steps: Array<[string, () => Promise<unknown>]> = [
			["cp", () => fs.cp("/home/user/a.txt", "/home/user/b.txt")],
			["chmod", () => fs.chmod("/home/user/a.txt", 0o755)],
			["mkdir -p", () => fs.mkdir("/home/user/x/y/z", { recursive: true })],
			["ln", () => fs.link("/home/user/a.txt", "/home/user/c.txt")],
			["ln -s", () => fs.symlink("/home/user/a.txt", "/home/user/s.txt")],
			["touch", () => fs.utimes("/home/user/a.txt", new Date(), new Date())],
			["cp -r", () => fs.cp("/home/user/x", "/home/user/xcopy", { recursive: true })],
			["ingest", () => fs.bulkIngest([{ path: "/home/user/i.txt", content: new Uint8Array(2), mode: 0o644 }])],
			["rm -r", () => fs.rm("/home/user/x", { recursive: true })],
		];

		const moved: Array<[string, boolean]> = [];
		for (const [label, run] of steps) {
			const before = await version(id);
			await run();
			moved.push([label, (await version(id)) > before]);
		}

		expect(moved).toEqual([
			["cp", true],
			["chmod", true],
			["mkdir -p", true],
			["ln", true],
			["ln -s", true],
			["touch", true],
			["cp -r", true],
			["ingest", true],
			["rm -r", true],
		]);
	});

	it("spends one epoch per directory mkdir -p actually creates, and none over an existing tree", async () => {
		const { fs, id } = await newFs("mkdirp");
		const before = await version(id);
		await fs.mkdir("/home/user/p/q/r", { recursive: true });
		expect(await version(id)).toBe(before + 3n);

		const afterFirst = await version(id);
		await fs.mkdir("/home/user/p/q", { recursive: true });
		expect(await version(id)).toBe(afterFirst);
	});

	it("leaves the epoch where it was when the mutation fails", async () => {
		const { fs, id } = await newFs("rollback");
		const before = await version(id);
		await expect(fs.chmod("/home/user/missing.txt", 0o600)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await version(id)).toBe(before);
	});

	it("does not fence a session out of its own next scope after a non-scoped write", async () => {
		const { fs, id } = await newFs("selfpin");
		// chmod advances `version`; the session must re-pin or its own next script
		// scope opens against a counter it moved itself and throws ESTALE.
		await fs.writeFile("/home/user/a.txt", "one");
		await fs.chmod("/home/user/a.txt", 0o700);

		fs.beginScriptScope();
		await fs.writeFile("/home/user/b.txt", "two");
		await fs.endScriptScope();

		fs.beginScriptScope();
		await expect(fs.writeFile("/home/user/c.txt", "three")).resolves.toBeUndefined();
		await fs.endScriptScope();
		expect(await version(id)).toBeGreaterThan(0n);
	});

	it("re-pins after a scope whose only writes were non-composite", async () => {
		const { fs } = await newFs("scopepin");
		await fs.writeFile("/home/user/a.txt", "one");

		fs.beginScriptScope();
		await fs.chmod("/home/user/a.txt", 0o755);
		await fs.mkdir("/home/user/d1/d2", { recursive: true });
		await fs.endScriptScope();

		// Without the end-of-scope re-pin the published epoch is short of what
		// COMMIT durably left behind, and this scope opens onto ESTALE.
		fs.beginScriptScope();
		await expect(fs.writeFile("/home/user/b.txt", "two")).resolves.toBeUndefined();
		await fs.endScriptScope();
	});
});

describe.skipIf(SKIP)("#192 — a stale pin is rejected by every carrier", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxIds = new Set<string>();

	beforeAll(async () => {
		await dialect.connect();
	});

	afterAll(async () => {
		for (const id of sandboxIds) await destroySandbox(dialect, id);
		await dialect.disconnect();
	});

	/**
	 * Models a lapsed lease exactly as `fencing.integration.test.ts` does: RLS
	 * context without the locking variant, so `app.sandbox_epoch` is NOT refreshed
	 * to the live row. That is the state a writer is in when its pin has gone
	 * stale; refreshing the GUC is what the composites' `version > expectedEpoch`
	 * branch is there to admit, and these carriers share that branch verbatim.
	 */
	async function seed(label: string): Promise<{ id: string; rootInodeId: bigint; fileInodeId: bigint; live: bigint }> {
		const id = uniqueId(label);
		sandboxIds.add(id);
		const created = await dialect.transaction((tx) => dialect.createSandbox(tx, id));
		const fileInodeId = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContextWithLock(tx, id);
			const inode = await dialect.createInode(tx, { sandboxId: id, kind: 1, mode: 0o644, size: 0 });
			await dialect.insertDirent(tx, created.rootInodeId, "a.txt", inode);
			await dialect.insertDirent(tx, created.rootInodeId, "q.txt", inode);
			return inode;
		});
		const rows = await dialect.transaction(
			(tx) => tx<{ version: string }[]>`SELECT version FROM sandboxes WHERE id = ${id}`,
		);
		return { id, rootInodeId: created.rootInodeId, fileInodeId, live: BigInt(rows[0]!.version) };
	}

	it("rejects a stale createInode, updateInode, incrementNlink, deleteDirent, moveDirent and bulkIngest", async () => {
		const { id, rootInodeId, fileInodeId, live } = await seed("stale");
		const stale = live - 1n;
		const cases: Array<[string, (tx: never) => Promise<unknown>]> = [
			["createInode", (tx) => dialect.createInode(tx, { sandboxId: id, kind: 1, mode: 0o644, size: 0 }, stale)],
			["updateInode", (tx) => dialect.updateInode(tx, fileInodeId, { mode: 0o600 }, id, stale)],
			["incrementNlink", (tx) => dialect.incrementNlink(tx, fileInodeId, id, stale)],
			["deleteDirent", (tx) => dialect.deleteDirent(tx, rootInodeId, "q.txt", id, stale)],
			["moveDirent", (tx) => dialect.moveDirent(tx, rootInodeId, "a.txt", rootInodeId, "r.txt", id, stale)],
			[
				"bulkIngest",
				(tx) => dialect.bulkIngest(tx, [{ path: "/z.txt", content: new Uint8Array(1), mode: 0o644 }], id, stale),
			],
		];

		const verdicts: Array<[string, string]> = [];
		for (const [label, run] of cases) {
			try {
				await dialect.transaction(async (tx) => {
					await dialect.setSandboxContext(tx, id);
					await run(tx as never);
				});
				verdicts.push([label, "accepted"]);
			} catch (err) {
				verdicts.push([label, (err as Error & { code?: string }).code ?? "unknown"]);
			}
		}

		expect(verdicts).toEqual([
			["createInode", "ESTALE"],
			["updateInode", "ESTALE"],
			["incrementNlink", "ESTALE"],
			["deleteDirent", "ESTALE"],
			["moveDirent", "ESTALE"],
			["bulkIngest", "ESTALE"],
		]);
		expect(
			(await dialect.transaction((tx) => tx<{ version: string }[]>`SELECT version FROM sandboxes WHERE id = ${id}`))[0]
				?.version,
		).toBe(live.toString());
	});

	/**
	 * The load-bearing one. A rejected write that is merely rolled back looks
	 * identical to a write that never happened, so a fence bolted on *after* the
	 * mutation would pass every test above. Here the ESTALE is swallowed and the
	 * transaction is allowed to COMMIT: only a mutation genuinely gated on the
	 * fence CTE leaves the row untouched.
	 */
	it("makes the mutation unreachable, not merely rolled back", async () => {
		const { id, rootInodeId, fileInodeId, live } = await seed("committed");
		const stale = live - 1n;

		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, id);
			for (const run of [
				() => dialect.updateInode(tx, fileInodeId, { mode: 0o600 }, id, stale),
				() => dialect.incrementNlink(tx, fileInodeId, id, stale),
				() => dialect.deleteDirent(tx, rootInodeId, "q.txt", id, stale),
				() => dialect.moveDirent(tx, rootInodeId, "a.txt", rootInodeId, "q.txt", id, stale),
			]) {
				await expect(run()).rejects.toMatchObject({ code: "ESTALE" });
			}
			// falls off the end → COMMIT
		});

		const after = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, id);
			const inode = await tx<{ mode: number; nlink: number }[]>`
				SELECT mode, nlink FROM inodes WHERE id = ${String(fileInodeId)}
			`;
			const dirent = await tx<{ n: number }[]>`
				SELECT count(*)::int AS n FROM dirents WHERE parent_inode_id = ${String(rootInodeId)} AND name = 'q.txt'
			`;
			const source = await tx<{ n: number }[]>`
				SELECT count(*)::int AS n FROM dirents WHERE parent_inode_id = ${String(rootInodeId)} AND name = 'a.txt'
			`;
			const sandbox = await tx<{ version: string }[]>`SELECT version FROM sandboxes WHERE id = ${id}`;
			return { inode: inode[0]!, dirents: dirent[0]!.n, source: source[0]!.n, version: sandbox[0]!.version };
		});

		expect(after.inode.mode).toBe(0o644);
		expect(after.inode.nlink).toBe(1);
		expect(after.dirents).toBe(1);
		expect(after.source).toBe(1);
		expect(after.version).toBe(live.toString());
	});
});
