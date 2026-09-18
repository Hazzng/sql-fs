import { describe, expect, it } from "vitest";
import { PostgresDialect } from "../dialects/postgres.js";

type RecordedSqlCall = { sql: string; values: readonly unknown[] };

function recordingTx(rows: unknown[] = [{ id: "42", inode_id: "42", new_inode_id: "42", removed_inode_id: "42" }]): {
	tx: ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & object;
	calls: RecordedSqlCall[];
} {
	const calls: RecordedSqlCall[] = [];
	const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ sql: strings.join("?"), values });
		return Promise.resolve(rows);
	}) as ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & object;
	return { tx, calls };
}

describe("PostgresDialect epoch fencing", () => {
	it("gates every composite mutation on its expected epoch in the locked ctx", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const makeCall = (run: (tx: never) => Promise<unknown>) => {
			const recording = recordingTx();
			return run(recording.tx as never).then(() => recording);
		};
		const recordings = await Promise.all([
			makeCall((tx) => dialect.mkdirComposite!(tx, "s1", 1n, "new", 0o755, 7n)),
			makeCall((tx) => dialect.rmComposite!(tx, "s1", 1n, "old", 7n)),
			makeCall((tx) =>
				dialect.writeFileComposite!(tx, "s1", 1n, "file", 0o644, 3, new Uint8Array(32), new Uint8Array(3), 7n),
			),
		]);
		for (const recording of recordings) {
			// calls[0] takes the writer lock; calls[1] runs the fenced CTE.
			expect(recording.calls).toHaveLength(2);
			const sql = recording.calls[1]!.sql;
			expect(sql).toContain("pg_advisory_xact_lock");
			expect(sql).toContain("FROM sandboxes");
			expect(sql).toContain("version");
			expect(recording.calls[1]!.values).toContain("7");
		}
	});

	it("throws the fenced no-row error when the ctx yields nothing", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const empty = recordingTx([]);
		await expect(dialect.mkdirComposite!(empty.tx as never, "s1", 1n, "new", 0o755, 7n)).rejects.toThrow(
			"mkdirComposite: INSERT returned no rows",
		);
		await expect(
			dialect.writeFileComposite!(
				empty.tx as never,
				"s1",
				1n,
				"file",
				0o644,
				3,
				new Uint8Array(32),
				new Uint8Array(3),
				7n,
			),
		).rejects.toThrow("writeFileComposite: INSERT returned no rows");
	});

	it("keeps the move's second statement inside the same epoch fence", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const recording = recordingTx();
		await dialect.mvComposite!(recording.tx as never, "s1", 1n, "old", 2n, "new", 7n);
		expect(recording.calls).toHaveLength(4);
		expect(recording.calls[3]!.sql).toContain("WITH ctx AS");
		expect(recording.calls[3]!.sql).toContain("pg_advisory_xact_lock");
		expect(recording.calls[3]!.sql).toContain("version");
	});

	it("returns a strictly advanced epoch on recreation and deletion", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const recording = recordingTx();
		recording.tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			recording.calls.push({ sql, values });
			if (sql.includes("DELETE FROM sandboxes")) return Promise.resolve([{ epoch: "10" }]);
			if (sql.includes("sandbox_epochs")) return Promise.resolve([{ epoch: "9" }]);
			if (sql.includes("INSERT INTO sandboxes"))
				return Promise.resolve([{ created_at: new Date("2026-01-01T00:00:00Z") }]);
			return Promise.resolve([{ id: "42" }]);
		}) as typeof recording.tx;

		const created = await dialect.createSandbox(recording.tx as never, "s1");
		expect(created.epoch).toBe(9n);
		const deleted = await dialect.deleteSandbox(recording.tx as never, "s1");
		expect(deleted).toBe(10n);
		const deletion = recording.calls.find((call) => call.sql.includes("DELETE FROM sandboxes"));
		expect(deletion?.sql).toContain("version + 1");
	});
});
