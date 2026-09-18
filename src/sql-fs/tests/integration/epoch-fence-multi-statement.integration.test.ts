/**
 * #192 — the epoch fence on the mutations that are not one composite CTE, against
 * a real Postgres.
 *
 * PR #191 fenced the four composites. `bulkIngest`, `mkdir -p`, `rm -r`, `cp`,
 * `link`, `symlink`, `chmod` and `utimes` went around them, which broke the fence
 * in two independent ways:
 *
 *   1. a zombie writer using one of these doors could still destroy a live
 *      writer's commit — #170's class, different door;
 *   2. a LIVE writer using one of them left `sandboxes.version` unmoved, so a
 *      genuinely stale peer's pin still matched and its next composite committed.
 *      Ordinary traffic silently disarmed the fence.
 *
 * Both are reproduced below as actual lost updates, not just as missing throws.
 *
 * What this file CANNOT see: whether the bump runs before or after the writes it
 * fences. Move it after them and every test here still passes, because SqlFs
 * throws and the transaction rolls back — the writes really did execute, and only
 * the rollback hides it. That ordering is pinned in
 * `unit/sql-fs.epoch-fence-multi-statement.test.ts`, which asserts the dialect
 * call sequence directly.
 *
 * Skipped when DATABASE_URL is not set.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("epoch fence — multi-statement mutations (#192)", () => {
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

	async function open(allowSymlinks = false): Promise<void> {
		sandboxId = `fence192-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		await admin.transaction((tx) => admin.createSandbox(tx, sandboxId, "owner"));
		a = new PostgresDialect(url!);
		b = new PostgresDialect(url!);
		await a.connect();
		await b.connect();
		fsA = new SqlFs({ dialect: a, sandboxId, allowSymlinks });
		fsB = new SqlFs({ dialect: b, sandboxId, allowSymlinks });
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

	it("advances the epoch exactly once per mutation that is not a composite", async () => {
		await open(true);
		await fsA.ready();
		await fsA.writeFile("/src.txt", "x");
		await fsA.mkdir("/tree");
		await fsA.writeFile("/tree/leaf.txt", "y");
		let expected = await version();

		const step = async (label: string, run: () => Promise<void>, by = 1n): Promise<void> => {
			await run();
			expected += by;
			expect({ label, version: await version() }).toEqual({ label, version: expected });
		};

		// One bump for the whole batch, however many files it carries — the added
		// cost of fencing an ingest is one UPDATE, not one per file.
		await step("bulkIngest", () =>
			fsA.bulkIngest([
				{ path: "/ing/one.txt", content: new TextEncoder().encode("1"), mode: 0o644 },
				{ path: "/ing/two.txt", content: new TextEncoder().encode("2"), mode: 0o644 },
				{ path: "/ing/three.txt", content: new TextEncoder().encode("3"), mode: 0o644 },
			]),
		);
		// mkdir -p is the one exception: a bump per segment it actually creates.
		await step("mkdir -p", () => fsA.mkdir("/deep/er/still", { recursive: true }), 3n);
		await step("mkdir -p (nothing to create)", () => fsA.mkdir("/deep/er", { recursive: true }), 0n);
		await step("cp", () => fsA.cp("/src.txt", "/copy.txt"));
		await step("cp -r", () => fsA.cp("/tree", "/tree2", { recursive: true }));
		await step("link", () => fsA.link("/src.txt", "/hard.txt"));
		await step("symlink", () => fsA.symlink("/src.txt", "/soft.txt"));
		await step("chmod", () => fsA.chmod("/src.txt", 0o600));
		await step("utimes", () => fsA.utimes("/src.txt", new Date(), new Date()));
		await step("rm -r", () => fsA.rm("/tree2", { recursive: true }));
	});

	/**
	 * Defect 1, as an actual lost update.
	 *
	 * A's pathCache still says `/shared.txt` is its own "base" inode. `cp` builds
	 * the destination dirent from that stale cache and upserts it, so a zombie A
	 * replaces B's committed content with a copy of its own stale world — exit 0,
	 * no error, bytes gone.
	 */
	it("fences a zombie writer coming through cp, leaving the live commit intact", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/shared.txt", "base\n");
		await fsA.writeFile("/stale-src.txt", "stale\n");
		await fsB.ready();
		await fsB.writeFile("/shared.txt", "from-B\n");

		await expect(fsA.cp("/stale-src.txt", "/shared.txt")).rejects.toThrow(/ESTALEEPOCH/);

		await fsB.reload();
		expect(await fsB.readFile("/shared.txt")).toBe("from-B\n");
	});

	/**
	 * Defect 2, as an actual lost update — the subtle half.
	 *
	 * B is LIVE and correct here. It just mutates through `cp`, which used to
	 * leave `sandboxes.version` alone; A's pin therefore still matched and A's
	 * fenced composite committed over B. The fence is only as precise as the
	 * counter is complete.
	 */
	it("a live writer using only cp still advances the epoch, so a stale peer's composite is fenced", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/shared.txt", "base\n");
		await fsA.writeFile("/replacement.txt", "from-B\n");
		await fsB.ready();
		await fsB.cp("/replacement.txt", "/shared.txt");

		// A never reloaded: its base for the append is the pre-cp "base\n".
		await expect(fsA.appendFile("/shared.txt", "A-line\n")).rejects.toThrow(/ESTALEEPOCH/);

		await fsB.reload();
		expect(await fsB.readFile("/shared.txt")).toBe("from-B\n");
	});

	it("fences every non-composite mutation on the same stale epoch and changes nothing", async () => {
		await open(true);
		await fsA.ready();
		await fsA.writeFile("/src.txt", "x");
		await fsA.mkdir("/tree");
		await fsA.writeFile("/tree/leaf.txt", "y");
		await fsB.ready();
		await fsB.writeFile("/b.txt", "advance the epoch");
		const epochAfterB = await version();
		const inodesAfterB = await countInodes();

		const ings = [{ path: "/ing.txt", content: new TextEncoder().encode("1"), mode: 0o644 }];
		await expect(fsA.bulkIngest(ings)).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.mkdir("/deep/er", { recursive: true })).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.rm("/tree", { recursive: true })).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.cp("/src.txt", "/copy.txt")).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.cp("/tree", "/tree2", { recursive: true })).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.link("/src.txt", "/hard.txt")).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.symlink("/src.txt", "/soft.txt")).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.chmod("/src.txt", 0o600)).rejects.toThrow(/ESTALEEPOCH/);
		await expect(fsA.utimes("/src.txt", new Date(), new Date())).rejects.toThrow(/ESTALEEPOCH/);

		// Nothing created, nothing removed, and the counter is where B left it — a
		// fence that bumped first and threw second would have moved it nine times.
		expect(await countInodes()).toBe(inodesAfterB);
		expect(await version()).toBe(epochAfterB);
		await fsB.reload();
		const paths = fsB.getAllPaths();
		expect(paths).toContain("/tree/leaf.txt");
		expect(paths).not.toContain("/ing.txt");
		expect(paths).not.toContain("/copy.txt");
		expect(paths).not.toContain("/tree2");
		expect(paths).not.toContain("/hard.txt");
		expect(paths).not.toContain("/soft.txt");
		expect(paths).not.toContain("/deep");
	});

	it("lets the fenced writer through again once it reloads", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/src.txt", "x");
		await fsB.ready();
		await fsB.writeFile("/b.txt", "advance the epoch");

		await expect(fsA.cp("/src.txt", "/copy.txt")).rejects.toThrow(/ESTALEEPOCH/);
		await fsA.reload();
		await fsA.cp("/src.txt", "/copy.txt");

		await fsB.reload();
		expect(await fsB.readFile("/copy.txt")).toBe("x");
	});

	/**
	 * The SQL contract with the TypeScript safety net removed.
	 *
	 * Everywhere else the fence is seen through `SqlFs`, which throws — so the
	 * transaction rolls back and a bump that was NOT conditional would still look
	 * clean. Here the error is swallowed and the transaction is COMMITTED, which
	 * is what a half-fixed build does.
	 *
	 * Note what this test can and cannot prove: it pins that the bump itself
	 * matches zero rows on a stale pin. That the mutations never run is a matter
	 * of statement ORDER inside the caller, which no SQL-level test can see — it
	 * is pinned in `unit/sql-fs.epoch-fence-multi-statement.test.ts`.
	 */
	it("a fenced bump that is committed anyway moves the counter by nothing", async () => {
		await open();
		await fsA.ready();
		await fsA.writeFile("/src.txt", "x");
		const before = await version();

		await admin.transaction(async (tx) => {
			await admin.setSandboxContextWithLock(tx, sandboxId);
			await expect(admin.bumpSandboxVersion(tx, sandboxId, before + 1000n)).rejects.toThrow(/ESTALEEPOCH/);
			// No rethrow: the transaction commits.
		});
		expect(await version()).toBe(before);

		// The other half, so the test above cannot pass by never bumping at all:
		// the correct pin does commit a +1.
		await admin.transaction(async (tx) => {
			await admin.setSandboxContextWithLock(tx, sandboxId);
			await admin.bumpSandboxVersion(tx, sandboxId, before);
		});
		expect(await version()).toBe(before + 1n);

		// And `null` is the unfenced sentinel: bump whatever the row says.
		await admin.transaction(async (tx) => {
			await admin.setSandboxContextWithLock(tx, sandboxId);
			await admin.bumpSandboxVersion(tx, sandboxId, null);
		});
		expect(await version()).toBe(before + 2n);
	});

	it("reports a bump against a sandbox that no longer exists as ESTALEEPOCH", async () => {
		await open();
		await fsA.ready();
		const gone = `${sandboxId}-never-created`;
		await admin.transaction(async (tx) => {
			await admin.setSandboxContext(tx, gone);
			await expect(admin.bumpSandboxVersion(tx, gone, 0n)).rejects.toThrow(/ESTALEEPOCH/);
		});
	});

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
