import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerCancellation } from "../../../execution/owner-cancellation.js";
import { PostgresDialect } from "../../dialects/postgres.js";
import { retirePostgresSandboxGeneration } from "../../index.js";
import { SqlFs } from "../../sql-fs.js";
import type { SandboxGeneration } from "../../types.js";
import { requireMigratedSchema } from "./helpers/schema-preconditions.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

class PausedPathDialect extends PostgresDialect {
	pause: { loaded: ReturnType<typeof deferred<void>>; resume: ReturnType<typeof deferred<void>> } | undefined;

	override async loadAllPaths(tx: postgres.TransactionSql): ReturnType<PostgresDialect["loadAllPaths"]> {
		const rows = await super.loadAllPaths(tx);
		const pause = this.pause;
		this.pause = undefined;
		if (pause !== undefined) {
			pause.loaded.resolve();
			await pause.resume.promise;
		}
		return rows;
	}
}

class PausedEpochDialect extends PostgresDialect {
	pause: { loaded: ReturnType<typeof deferred<void>>; resume: ReturnType<typeof deferred<void>> } | undefined;

	override async getSandboxEpoch(tx: postgres.TransactionSql, sandboxId: string): Promise<bigint> {
		const epoch = await super.getSandboxEpoch(tx, sandboxId);
		const pause = this.pause;
		this.pause = undefined;
		if (pause !== undefined) {
			pause.loaded.resolve();
			await pause.resume.promise;
		}
		return epoch;
	}
}

class ObservedRetirementDialect extends PostgresDialect {
	readonly started = deferred<number>();

	override async retireSandboxGeneration(
		tx: postgres.TransactionSql,
		sandboxId: string,
		assertOwnerLease?: () => void,
	): Promise<SandboxGeneration> {
		const rows = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
		this.started.resolve(rows[0]!.pid);
		return super.retireSandboxGeneration(tx, sandboxId, assertOwnerLease);
	}
}

describe.skipIf(!process.env.DATABASE_URL)("durable cache generations", () => {
	const databaseUrl = process.env.DATABASE_URL ?? "";
	const admin = new PostgresDialect(databaseUrl);
	const dialects: PostgresDialect[] = [];
	const ids = new Set<string>();

	beforeAll(async () => {
		await requireMigratedSchema(databaseUrl);
		await admin.connect();
	});

	afterAll(async () => {
		for (const id of ids) {
			await admin.transaction(async (tx) => {
				await admin.deleteSandbox(tx, id);
				await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
				const rows = await tx`SELECT id FROM sandboxes WHERE id = ${id}`;
				expect(rows).toHaveLength(0);
			});
		}
		await Promise.all(dialects.map((dialect) => dialect.disconnect()));
		await admin.disconnect();
	});

	async function connect<D extends PostgresDialect>(dialect: D): Promise<D> {
		await dialect.connect();
		dialects.push(dialect);
		dialect.getBlobsForSandbox = async () => [];
		return dialect;
	}

	async function sandbox(): Promise<string> {
		const id = `durable198-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		ids.add(id);
		await admin.transaction((tx) => admin.createSandbox(tx, id));
		return id;
	}

	async function open(id: string, buffered = false, dialect?: PostgresDialect): Promise<SqlFs> {
		const instance = dialect ?? (await connect(new PostgresDialect(databaseUrl)));
		const fs = new SqlFs({
			dialect: instance,
			sandboxId: id,
			scriptTxBuffer: { enabled: buffered, maxOps: 100, maxBytes: 1024 * 1024 },
		});
		await fs.ready();
		return fs;
	}

	it("rolls back an unbuffered mutation when the owner lease is lost during epoch settlement", async () => {
		const id = await sandbox();
		const dialect = await connect(new PausedEpochDialect(databaseUrl));
		const fs = await open(id, false, dialect);
		await fs.writeFile("/home/user/value", "original");
		const originalMode = (await fs.stat("/home/user/value")).mode;
		const words = new Int32Array(new SharedArrayBuffer(8));
		await ownerCancellation.run(words, async () => {
			fs.beginScriptScope();
			await fs.chmod("/home/user/value", 0o600);
			await fs.writeFile("/home/user/prefix", "must roll back");
			await fs.chmod("/home/user/value", 0o400);
			const pause = { loaded: deferred<void>(), resume: deferred<void>() };
			dialect.pause = pause;
			const ending = fs.endScriptScope();
			const rejected = expect(ending).rejects.toMatchObject({ code: "ELOCKLOST" });
			await pause.loaded.promise;
			Atomics.store(words, 1, 1);
			pause.resume.resolve();
			await rejected;
		});
		expect(fs.scriptScopeActive).toBe(false);
		expect(fs.scriptTxOpen).toBe(false);
		expect((await fs.stat("/home/user/value")).mode).toBe(originalMode);
		expect(await fs.exists("/home/user/prefix")).toBe(false);
		const fresh = await open(id);
		expect((await fresh.stat("/home/user/value")).mode).toBe(originalMode);
		expect(await fresh.readFile("/home/user/value")).toBe("original");
		expect(await fresh.exists("/home/user/prefix")).toBe(false);
		await fs.writeFile("/home/user/after", "reusable");
		await fresh.ensureFresh();
		expect(await fresh.readFile("/home/user/after")).toBe("reusable");
	});

	it("refreshes a warm replica after a commit with no Redis publication", async () => {
		const id = await sandbox();
		const writer = await open(id);
		await writer.writeFile("/home/user/value", "old");
		const reader = await open(id);
		expect(await reader.readFile("/home/user/value")).toBe("old");
		await writer.writeFile("/home/user/value", "new");
		await reader.ensureFresh();
		expect(await reader.readFile("/home/user/value")).toBe("new");
	});

	it("keeps an old image paired with its old epoch when another replica commits during reload", async () => {
		const id = await sandbox();
		const writer = await open(id);
		await writer.writeFile("/home/user/value", "old");
		const dialect = await connect(new PausedPathDialect(databaseUrl));
		const reader = await open(id, true, dialect);
		const pause = { loaded: deferred<void>(), resume: deferred<void>() };
		dialect.pause = pause;
		const reloading = reader.reload();
		await pause.loaded.promise;
		try {
			await writer.writeFile("/home/user/value", "new");
		} finally {
			pause.resume.resolve();
		}
		await reloading;
		expect(await reader.readFile("/home/user/value")).toBe("old");
		reader.beginScriptScope();
		await reader.writeFile("/home/user/value", "old-overwrite");
		await expect(reader.endScriptScope()).rejects.toMatchObject({ code: "ESTALE" });
		await writer.ensureFresh();
		expect(await writer.readFile("/home/user/value")).toBe("new");
		await reader.ensureFresh();
		expect(await reader.readFile("/home/user/value")).toBe("new");
	});

	it("fences a buffered journal before a replacement makes any data mutation", async () => {
		const id = await sandbox();
		const old = await open(id, true);
		old.beginScriptScope();
		await old.writeFile("/home/user/late", "must not commit");
		const replacement = await open(id);
		await replacement.claimGeneration();
		expect(await replacement.exists("/home/user/late")).toBe(false);
		await expect(old.endScriptScope()).rejects.toMatchObject({ code: "ESTALE" });
		const fresh = await open(id);
		expect(await fresh.exists("/home/user/late")).toBe(false);
	});

	it("retirement rejects direct writes and non-composite metadata writes from an old image", async () => {
		const id = await sandbox();
		const old = await open(id);
		await old.writeFile("/home/user/value", "original");
		await retirePostgresSandboxGeneration(databaseUrl, id);
		await expect(old.writeFile("/home/user/value", "late")).rejects.toMatchObject({ code: "ESTALE" });
		await expect(old.chmod("/home/user/value", 0o777)).rejects.toMatchObject({ code: "ESTALE" });
		await expect(old.mkdir("/home/user/a/b", { recursive: true })).rejects.toMatchObject({ code: "ESTALE" });
		const fresh = await open(id);
		expect(await fresh.readFile("/home/user/value")).toBe("original");
		expect((await fresh.stat("/home/user/value")).mode).toBe(0o644);
		expect(await fresh.exists("/home/user/a")).toBe(false);
	});

	it("waits for an accepted writer COMMIT before returning a retirement certificate", async () => {
		const id = await sandbox();
		const writer = await open(id);
		writer.beginScriptScope();
		await writer.writeFile("/home/user/value", "committed before retirement");
		const control = await connect(new ObservedRetirementDialect(databaseUrl));
		const retiring = control.transaction((tx) => control.retireSandboxGeneration(tx, id));
		const pid = await control.started.promise;
		let blocked = false;
		try {
			for (let attempt = 0; attempt < 100; attempt++) {
				const rows = await admin.transaction(
					(tx) => tx<{ waiting: boolean }[]>`
					SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted) AS waiting
				`,
				);
				if (rows[0]?.waiting) {
					blocked = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(blocked).toBe(true);
		} finally {
			await writer.endScriptScope();
		}
		const retiredEpoch = await retiring;
		const live = await admin.transaction((tx) => admin.getSandboxEpoch(tx, id));
		expect(retiredEpoch.epoch).toBe(live);
		const fresh = await open(id);
		expect(await fresh.readFile("/home/user/value")).toBe("committed before retirement");
		await expect(writer.writeFile("/home/user/value", "late")).rejects.toMatchObject({ code: "ESTALE" });
	});

	it("fences a buffered scope through the standalone owner-retirement barrier", async () => {
		const id = await sandbox();
		const old = await open(id, true);
		old.beginScriptScope();
		await old.writeFile("/home/user/abandoned", "uncommitted");
		await retirePostgresSandboxGeneration(databaseUrl, id);
		await expect(old.ensureFresh()).rejects.toMatchObject({ code: "EBUSY" });
		await expect(old.endScriptScope()).rejects.toMatchObject({ code: "ESTALE" });
		const replacement = await open(id);
		await replacement.claimGeneration();
		expect(await replacement.exists("/home/user/abandoned")).toBe(false);
		await replacement.writeFile("/home/user/value", "healthy");
		const fresh = await open(id);
		expect(await fresh.exists("/home/user/abandoned")).toBe(false);
		expect(await fresh.readFile("/home/user/value")).toBe("healthy");
	});

	it("fails freshness checks when Postgres is unavailable instead of accepting the cached image", async () => {
		const id = await sandbox();
		const dialect = await connect(new PostgresDialect(databaseUrl));
		const fs = await open(id, false, dialect);
		await fs.writeFile("/home/user/value", "cached");
		await dialect.disconnect();
		await expect(fs.ensureFresh()).rejects.toThrow();
	});
});
