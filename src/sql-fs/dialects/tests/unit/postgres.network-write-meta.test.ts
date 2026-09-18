/**
 * Unit tests for the `network_write` sandbox-meta column (migration 0008).
 *
 * Uses a fake transaction handle (the pattern from postgres.advisory-lock)
 * so the SQL composition and the row mapping are checked without a database.
 */

import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDialect } from "../../postgres.js";

interface RecordedCall {
	readonly sql: string;
	readonly values: readonly unknown[];
}

function makeFakeTx(rows: unknown[] = []): { tx: postgres.TransactionSql; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		calls.push({ sql: strings.join("?"), values });
		return Promise.resolve(rows);
	};
	return { tx: fn as unknown as postgres.TransactionSql, calls };
}

const CREATED_AT = new Date("2026-09-18T00:00:00.000Z");

describe("PostgresDialect.getSandboxMeta — network_write", () => {
	it("maps network_write onto networkWrite", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx([
			{
				owner: "alice",
				name: "box",
				python: true,
				javascript: false,
				network: true,
				network_write: true,
				created_at: CREATED_AT,
			},
		]);

		const meta = await dialect.getSandboxMeta(tx, "sandbox-1");

		expect(meta).toEqual({
			owner: "alice",
			name: "box",
			python: true,
			javascript: false,
			network: true,
			networkWrite: true,
			createdAt: "2026-09-18T00:00:00.000Z",
		});
		expect(calls[0]!.sql).toContain("network_write");
	});

	it("reports networkWrite false for a sandbox created without the capability", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx } = makeFakeTx([
			{
				owner: "alice",
				name: null,
				python: false,
				javascript: false,
				network: true,
				network_write: false,
				created_at: CREATED_AT,
			},
		]);

		const meta = await dialect.getSandboxMeta(tx, "sandbox-1");

		expect(meta?.networkWrite).toBe(false);
	});
});

describe("PostgresDialect.updateSandboxMeta — network_write", () => {
	it("writes networkWrite as a bound parameter", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx([{ id: "sandbox-1" }]);

		await dialect.updateSandboxMeta(tx, "sandbox-1", {
			owner: "alice",
			name: "box",
			python: false,
			javascript: false,
			network: true,
			networkWrite: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]!.sql).toContain("network_write = ");
		expect(calls[0]!.values).toEqual(["alice", "box", false, false, true, true, "sandbox-1"]);
	});

	it("defaults a meta record with no networkWrite to false", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx([{ id: "sandbox-1" }]);

		await dialect.updateSandboxMeta(tx, "sandbox-1", {
			owner: null,
			name: null,
			python: false,
			javascript: false,
			network: false,
		});

		expect(calls[0]!.values).toEqual([null, null, false, false, false, false, "sandbox-1"]);
	});
});

describe("PostgresDialect.listSandboxes — network_write", () => {
	it("selects and maps network_write for every row", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx([
			{
				id: "sandbox-1",
				name: "box",
				owner: "alice",
				created_at: CREATED_AT,
				python: false,
				javascript: false,
				network: true,
				network_write: true,
			},
		]);

		const entries = await dialect.listSandboxes(tx, "alice");

		expect(entries).toEqual([
			{
				id: "sandbox-1",
				name: "box",
				owner: "alice",
				createdAt: CREATED_AT,
				python: false,
				javascript: false,
				network: true,
				networkWrite: true,
			},
		]);
		expect(calls[0]!.sql).toContain("network_write");
	});
});
