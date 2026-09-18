/**
 * #131 / #170 — the epoch fence against a real Postgres.
 *
 * The unit suite proves what SqlFs stamps and what it does with a fenced
 * verdict; only a real database proves the half that matters: that a zero-row
 * conditional `UPDATE sandboxes SET version = version + 1` leaves the rest of
 * the composite writing NOTHING, and that the live writer's committed dirent is
 * still there afterwards.
 *
 * Two SqlFs instances on their own connections stand in for two replicas: A
 * loads its pathCache (pinning the epoch), B commits an append, then A appends
 * from the base it captured before B existed — exactly the zombie-writer shape,
 * with the lease modelled by "A simply never reloaded".
 *
 * Skipped when DATABASE_URL is not set.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("epoch fence (#131)", () => {
	const admin = new PostgresDialect(url!);
	let sandboxId: string;
	let a: PostgresDialect;
	let b: PostgresDialect;
	let fsA: SqlFs;
	let fsB: SqlFs;

	beforeAll(async () => {
		await admin.connect();
	});

	afterAll(async () => {
		await admin.disconnect();
	});

	async function open(): Promise<void> {
		sandboxId = `fence-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		await admin.transaction((tx) => admin.createSandbox(tx, sandboxId, "owner"));
		a = new PostgresDialect(url!);
		b = new PostgresDialect(url!);
		await a.connect();
		await b.connect();
		fsA = new SqlFs({ dialect: a, sandboxId });
		fsB = new SqlFs({ dialect: b, sandboxId });
	}

	afterEach(async () => {
		try {
			await admin.transaction((tx) => admin.deleteSandbox(tx, sandboxId));
		} finally {
			await a.disconnect();
			await b.disconnect();
		}
	});

	async function version(): Promise<bigint> {
		const v = await admin.transaction((tx) => admin.getSandboxVersion(tx, sandboxId));
		if (v === null) throw new Error("sandbox row missing");
		return v;
	}

	it("starts a fresh sandbox at epoch 0 and advances it once per composite write", async () => {
		await open();
		await fsA.ready();
		expect(await version()).toBe(0n);

		await fsA.writeFile("/home/user/f.txt", "one");
		expect(await version()).toBe(1n);

		await fsA.mkdir("/home/user/d");
		expect(await version()).toBe(2n);

		await fsA.mv("/home/user/f.txt", "/home/user/g.txt");
		expect(await version()).toBe(3n);

		await fsA.rm("/home/user/g.txt");
		expect(await version()).toBe(4n);
	});

	it("rejects a zombie writer's append and leaves the live writer's commit intact (#170)", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/shared.txt", "base\n");
		// A now holds `/shared.txt` -> sha256("base\n") in its pathCache. This is the
		// stale base a lapsed-lease writer keeps using: content-addressed, so `getBlob`
		// happily serves it long after B has replaced the dirent.
		await fsB.ready();
		await fsB.appendFile("/shared.txt", "B-line\n");
		expect(await version()).toBe(2n);

		// A's script: it never reloaded, so its epoch is still the pre-B value.
		fsA.beginScriptScope();
		await expect(fsA.appendFile("/shared.txt", "A-line\n")).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.endScriptScope()).rejects.toThrow(/ESTALEEPOCH/);

		// B's bytes are still the committed content, and A's rolled-back statement
		// bumped nothing.
		await fsB.reload();
		expect(await fsB.readFile("/shared.txt")).toBe("base\nB-line\n");
		expect(await version()).toBe(2n);
	});

	it("writes nothing at all from a fenced statement — no orphan inode, no dropped dirent", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/shared.txt", "base\n");
		await fsB.ready();
		await fsB.appendFile("/shared.txt", "B-line\n");
		const inodesAfterB = await countInodes();
		const inodeAfterB = await resolve("/shared.txt");

		await expect(fsA.writeFile("/shared.txt", "A-clobber\n")).rejects.toThrow(/ESTALEEPOCH/);

		// The fenced statement's `new_inode` CTE selects FROM fence and `old_dirent`
		// is cross-joined with it, so neither does a new inode appear nor does the
		// live writer's inode vanish — a fence that gated only the INSERTs would
		// leave the dirent pointing at a deleted row.
		expect(await countInodes()).toBe(inodesAfterB);
		expect(await resolve("/shared.txt")).toBe(inodeAfterB);
		await fsB.reload();
		expect(await fsB.readFile("/shared.txt")).toBe("base\nB-line\n");
	});

	it("fences mkdir, rm and mv on the same stale epoch", async () => {
		await open();
		await fsA.ready();
		await fsA.mkdir("/home/user/victim");
		await fsA.writeFile("/home/user/src.txt", "x");
		await fsB.ready();
		await fsB.writeFile("/b.txt", "advance the epoch");

		await expect(fsA.mkdir("/home/user/new")).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.rm("/home/user/victim")).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.mv("/home/user/src.txt", "/home/user/dst.txt")).rejects.toThrow(/ESTALEEPOCH/);

		await fsB.reload();
		// mv is two statements; a fence that only gated statement 1 would still have
		// renamed the dirent in statement 2.
		expect(fsB.getAllPaths()).toContain("/home/user/src.txt");
		expect(fsB.getAllPaths()).not.toContain("/home/user/dst.txt");
		expect(fsB.getAllPaths()).toContain("/home/user/victim");
	});

	it("lets the fenced writer through again once it reloads", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/shared.txt", "base\n");
		await fsB.ready();
		await fsB.appendFile("/shared.txt", "B-line\n");

		await expect(fsA.appendFile("/shared.txt", "A-line\n")).rejects.toThrow(/ESTALEEPOCH/);
		await fsA.reload();
		await fsA.appendFile("/shared.txt", "A-line\n");

		await fsB.reload();
		expect(await fsB.readFile("/shared.txt")).toBe("base\nB-line\nA-line\n");
	});

	/**
	 * The SQL contract on its own, with the TypeScript safety net removed.
	 *
	 * Every other test here sees a fenced composite through `SqlFs`, which throws
	 * and therefore rolls the transaction back — so a fenced statement that DID
	 * destroy rows would still look clean. Here the error is swallowed and the
	 * transaction is COMMITTED, which is exactly what a half-fixed build does: a
	 * fence that gates only the INSERTs still runs `deleted_old_inode`, dropping
	 * the live writer's inode and cascading its dirent away.
	 */
	it("a fenced composite that is committed anyway still changes nothing", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/shared.txt", "base\n");
		// mv's destination has to EXIST, or its `old_dest` CTE deletes nothing
		// whether or not it is fenced and the gate looks covered when it is not.
		await fsA.writeFile("/dest.txt", "destination\n");
		const liveInode = await resolve("/shared.txt");
		const destInode = await resolve("/dest.txt");
		const inodesBefore = await countInodes();
		const epochBefore = await version();

		const stale = epochBefore + 1000n;
		const dir = await resolve("/");
		const bytes = new TextEncoder().encode("clobber\n");
		const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		await admin.commitBlob(sha, bytes);

		await admin.transaction(async (tx) => {
			await admin.setSandboxContextWithLock(tx, sandboxId);
			await expect(
				admin.writeFileComposite(tx, sandboxId, dir, "shared.txt", 0o644, bytes.length, sha, bytes, stale),
			).rejects.toThrow(/ESTALEEPOCH/);
			await expect(admin.rmComposite(tx, sandboxId, dir, "shared.txt", stale)).rejects.toThrow(/ESTALEEPOCH/);
			await expect(admin.mvComposite(tx, sandboxId, dir, "shared.txt", dir, "dest.txt", stale)).rejects.toThrow(
				/ESTALEEPOCH/,
			);
			await expect(admin.mkdirComposite(tx, sandboxId, dir, "newdir", 0o755, stale)).rejects.toThrow(/ESTALEEPOCH/);
			// No rethrow: the transaction commits.
		});

		expect(await countInodes()).toBe(inodesBefore);
		expect(await resolve("/shared.txt")).toBe(liveInode);
		expect(await resolve("/dest.txt")).toBe(destInode);
		expect(await version()).toBe(epochBefore);
		await fsB.ready();
		expect(await fsB.readFile("/shared.txt")).toBe("base\n");
		expect(await fsB.readFile("/dest.txt")).toBe("destination\n");
		expect(fsB.getAllPaths()).not.toContain("/newdir");
	});

	it("does not spend an epoch on a composite that finds nothing to do", async () => {
		await open();
		await fsA.ready();
		const dir = await resolve("/");
		const before = await version();

		// A correct pin, but the target does not exist: the composite must raise
		// ENOENT with the counter untouched. A fence that bumped first would leave
		// the caller's in-memory pin one behind and silently fence its next write.
		await admin.transaction(async (tx) => {
			await admin.setSandboxContextWithLock(tx, sandboxId);
			await expect(admin.rmComposite(tx, sandboxId, dir, "ghost.txt", before)).rejects.toThrow(/ENOENT/);
			await expect(admin.mvComposite(tx, sandboxId, dir, "ghost.txt", dir, "dst.txt", before)).rejects.toThrow(
				/ENOENT/,
			);
		});

		expect(await version()).toBe(before);
	});

	it("bumps only its own sandbox's epoch", async () => {
		await open();
		const otherId = `${sandboxId}-other`;
		await admin.transaction((tx) => admin.createSandbox(tx, otherId, "owner"));
		try {
			await fsA.ready();
			await fsA.writeFile("/f.txt", "x");
			const other = await admin.transaction((tx) => admin.getSandboxVersion(tx, otherId));
			expect(other).toBe(0n);
		} finally {
			await admin.transaction((tx) => admin.deleteSandbox(tx, otherId));
		}
	});

	async function resolve(path: string): Promise<bigint> {
		return admin.transaction(async (tx) => {
			await admin.setSandboxContext(tx, sandboxId);
			return admin.resolvePath(tx, path, true);
		});
	}

	async function countInodes(): Promise<number> {
		return admin.transaction(async (tx) => {
			await admin.setSandboxContext(tx, sandboxId);
			const rows = await (tx as never as (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ n: string }[]>)`
				SELECT count(*)::text AS n FROM inodes WHERE sandbox_id = ${sandboxId}
			`;
			return Number(rows[0]!.n);
		});
	}
});
