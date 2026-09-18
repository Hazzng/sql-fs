/**
 * PostgresDialect.ingestBlobs — the touch-then-insert protocol.
 *
 * Uses a fake pool that records every statement, so the two-statement shape,
 * the dedup rules and the Redis backfill can be asserted without a database.
 */

import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { RedisBlobCache } from "../../../redis-blob-cache.js";
import { PostgresDialect } from "../../postgres.js";

interface FakePool {
	readonly pool: postgres.Sql;
	readonly statements: string[];
	readonly inserted: () => Array<{ sha256: Buffer; data: Uint8Array; size: number }>;
}

function hash(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

/** `present` lists the hex hashes the UPDATE ... RETURNING should report. */
function makeFakePool(present: readonly string[]): FakePool {
	const statements: string[] = [];
	const insertRows: Array<{ sha256: Buffer; data: Uint8Array; size: number }> = [];

	const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		const sql = strings.join("?");
		statements.push(sql.replace(/\s+/g, " ").trim());
		if (sql.includes("UPDATE blobs SET last_referenced_at")) {
			return Promise.resolve(present.map((hex) => ({ sha256: Buffer.from(hex, "hex") })));
		}
		if (sql.includes("INSERT INTO blobs")) {
			for (const value of values) {
				if (Array.isArray(value)) insertRows.push(...(value as typeof insertRows));
			}
			return Promise.resolve([]);
		}
		return Promise.resolve([]);
	};
	// `db(rows)` is postgres.js's insert helper; the fake just forwards the rows.
	const callable = (arg: unknown): unknown => arg;
	const pool = Object.assign(
		(...args: unknown[]): unknown =>
			Array.isArray(args[0]) && "raw" in (args[0] as object)
				? tagged(args[0] as unknown as TemplateStringsArray, ...args.slice(1))
				: callable(args[0]),
		{ array: (value: unknown) => value },
	);

	return { pool: pool as unknown as postgres.Sql, statements, inserted: () => insertRows };
}

function injectPool(dialect: PostgresDialect, pool: postgres.Sql): void {
	(dialect as unknown as Record<string, unknown>).pool = pool;
}

describe("PostgresDialect.ingestBlobs", () => {
	it("touches first and inserts only the hashes the touch did not return", async () => {
		const fake = makeFakePool([Buffer.from(hash(0x11)).toString("hex")]);
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		await dialect.ingestBlobs([
			{ sha256: hash(0x11), data: new Uint8Array([1]) },
			{ sha256: hash(0x22), data: new Uint8Array([2]) },
		]);

		expect(fake.statements.length).toBe(2);
		expect(fake.statements[0]!.startsWith("UPDATE blobs SET last_referenced_at = now() WHERE sha256 = ANY(")).toBe(
			true,
		);
		expect(fake.statements[1]).toBe(
			"INSERT INTO blobs ? ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()",
		);
		expect(fake.inserted().map((r) => r.sha256.toString("hex"))).toEqual([Buffer.from(hash(0x22)).toString("hex")]);
	});

	it("issues no INSERT when every hash is already stored", async () => {
		const fake = makeFakePool([Buffer.from(hash(0x11)).toString("hex")]);
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		await dialect.ingestBlobs([{ sha256: hash(0x11), data: new Uint8Array([1]) }]);

		expect(fake.statements.length).toBe(1);
	});

	it("inserts a hash repeated within the batch exactly once", async () => {
		const fake = makeFakePool([]);
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		await dialect.ingestBlobs([
			{ sha256: hash(0x33), data: new Uint8Array([3]) },
			{ sha256: hash(0x33), data: new Uint8Array([3]) },
			{ sha256: hash(0x44), data: new Uint8Array([4]) },
		]);

		expect(fake.inserted().map((r) => r.sha256.toString("hex"))).toEqual([
			Buffer.from(hash(0x33)).toString("hex"),
			Buffer.from(hash(0x44)).toString("hex"),
		]);
	});

	it("backfills Redis only for the hashes it inserted", async () => {
		const setSpy = vi.fn(async (_sha: Uint8Array, _data: Uint8Array) => undefined);
		const cache = { get: vi.fn(async () => null), set: setSpy } as unknown as RedisBlobCache;
		const fake = makeFakePool([Buffer.from(hash(0x11)).toString("hex")]);
		const dialect = new PostgresDialect("postgres://stub", cache);
		injectPool(dialect, fake.pool);

		await dialect.ingestBlobs([
			{ sha256: hash(0x11), data: new Uint8Array([1]) },
			{ sha256: hash(0x22), data: new Uint8Array([2]) },
		]);

		expect(setSpy).toHaveBeenCalledTimes(1);
		expect(Buffer.from(setSpy.mock.calls[0]![0]).toString("hex")).toBe(Buffer.from(hash(0x22)).toString("hex"));
	});

	it("issues no statement for an empty batch", async () => {
		const fake = makeFakePool([]);
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		await dialect.ingestBlobs([]);

		expect(fake.statements).toEqual([]);
	});
});
