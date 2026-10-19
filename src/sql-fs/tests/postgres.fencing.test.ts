import { describe, expect, it } from "vitest";
import { PostgresDialect } from "../dialects/postgres.js";

type RecordedSqlCall = { sql: string; values: readonly unknown[] };
type Rows = unknown[] | ((sql: string) => unknown[]);

function recordingTx(rows: Rows = [{ id: "42", inode_id: "42", new_inode_id: "42", removed_inode_id: "42" }]): {
	tx: never;
	calls: RecordedSqlCall[];
} {
	const calls: RecordedSqlCall[] = [];
	const recorded = new WeakMap<Promise<unknown[]>, RecordedSqlCall>();
	const tx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		let sql = strings[0]!;
		const flat: unknown[] = [];
		values.forEach((value, index) => {
			const fragment = value instanceof Promise ? recorded.get(value) : undefined;
			if (fragment === undefined) {
				sql += "?";
				flat.push(value);
			} else {
				sql += fragment.sql;
				flat.push(...fragment.values);
				const at = calls.indexOf(fragment);
				if (at >= 0) calls.splice(at, 1);
			}
			sql += strings[index + 1]!;
		});
		const call = { sql: sql.replace(/\s+/g, " ").trim(), values: flat };
		calls.push(call);
		const query = Promise.resolve(typeof rows === "function" ? rows(call.sql) : rows);
		recorded.set(query, call);
		return query;
	};
	return { tx: tx as never, calls };
}

describe("PostgresDialect epoch fencing", () => {
	it("gates every composite mutation on its expected epoch in the locked ctx", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const makeCall = (run: (tx: never) => Promise<unknown>) => {
			const recording = recordingTx();
			return run(recording.tx).then(() => recording);
		};
		const recordings = await Promise.all([
			makeCall((tx) => dialect.mkdirComposite!(tx, "s1", 1n, "new", 0o755, 7n)),
			makeCall((tx) => dialect.rmComposite!(tx, "s1", 1n, "old", 7n)),
			makeCall((tx) =>
				dialect.writeFileComposite!(tx, "s1", 1n, "file", 0o644, 3, new Uint8Array(32), new Uint8Array(3), 7n),
			),
		]);
		for (const recording of recordings) {
			expect(recording.calls).toHaveLength(2);
			expect(recording.calls[0]!.sql).toBe("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))");
			const sql = recording.calls[1]!.sql;
			expect(sql).toContain("WITH ctx AS ( SELECT set_config('app.sandbox_id', ?, true)");
			expect(sql).toContain("pg_advisory_xact_lock");
			expect(recording.calls[1]!.values).toContain("7");
		}
	});

	it("throws the fenced no-row error when the ctx yields nothing", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const empty = recordingTx([]);
		await expect(dialect.mkdirComposite!(empty.tx, "s1", 1n, "new", 0o755, 7n)).rejects.toThrow(
			"mkdirComposite: INSERT returned no rows",
		);
		await expect(
			dialect.writeFileComposite!(empty.tx, "s1", 1n, "file", 0o644, 3, new Uint8Array(32), new Uint8Array(3), 7n),
		).rejects.toThrow("writeFileComposite: INSERT returned no rows");
	});

	it("keeps the move's second statement inside the same epoch fence", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const recording = recordingTx();
		await dialect.mvComposite!(recording.tx, "s1", 1n, "old", 2n, "new", 7n);
		expect(recording.calls).toHaveLength(4);
		expect(recording.calls[2]!.sql).toBe("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))");
		expect(recording.calls[3]!.sql).toContain("WITH ctx AS");
		expect(recording.calls[3]!.sql).toContain("pg_advisory_xact_lock");
	});

	it("returns a strictly advanced epoch on recreation and deletion", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const recording = recordingTx((sql) => {
			if (sql.includes("DELETE FROM sandboxes")) return [{ epoch: "10" }];
			if (sql.includes("sandbox_epochs")) return [{ epoch: "9" }];
			if (sql.includes("INSERT INTO sandboxes")) return [{ created_at: new Date("2026-01-01T00:00:00Z") }];
			return [{ id: "42" }];
		});

		const created = await dialect.createSandbox(recording.tx, "s1");
		expect(created.epoch).toBe(9n);
		const deleted = await dialect.deleteSandbox(recording.tx, "s1");
		expect(deleted).toBe(10n);
		const deletion = recording.calls.find((call) => call.sql.includes("DELETE FROM sandboxes"));
		expect(deletion?.sql).toContain("version + 1");
	});
});
