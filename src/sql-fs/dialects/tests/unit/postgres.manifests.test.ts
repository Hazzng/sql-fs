/**
 * PostgresDialect manifest lookups against a fake pool: the format predicate,
 * the empty-result path and the decoding of the returned row, with no database.
 * Follows the fake-pool shape of `postgres.ingest-blobs.test.ts`.
 */

import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { MANIFEST_FORMAT } from "../../../package-manifest.js";
import { PostgresDialect } from "../../postgres.js";

interface ManifestRow {
	wheel_sha256: Buffer;
	manifest_format: number;
	name: string;
	version: string;
	file_count: number;
	total_bytes: string;
}

interface FakePool {
	readonly pool: postgres.Sql;
	readonly statements: string[];
	readonly params: unknown[][];
}

function wheelHash(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

/**
 * `stored` is the single row the SELECT would return; the fake applies the same
 * `(wheel_sha256, manifest_format)` predicate the statement carries, so a row
 * written in another format reads back as no row at all.
 */
function makeFakePool(stored: ManifestRow | undefined): FakePool {
	const statements: string[] = [];
	const params: unknown[][] = [];

	const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		const sql = strings.join("?");
		statements.push(sql.replace(/\s+/g, " ").trim());
		params.push(values);
		if (sql.includes("FROM package_manifests")) {
			const [wheel, format] = values as [Buffer, number];
			if (stored?.wheel_sha256.equals(wheel) && stored.manifest_format === format) {
				return Promise.resolve([stored]);
			}
			return Promise.resolve([]);
		}
		return Promise.resolve([]);
	};
	const pool = Object.assign(
		(...args: unknown[]): unknown =>
			Array.isArray(args[0]) && "raw" in (args[0] as object)
				? tagged(args[0] as unknown as TemplateStringsArray, ...args.slice(1))
				: args[0],
		{ array: (value: unknown) => value },
	);

	return { pool: pool as unknown as postgres.Sql, statements, params };
}

function injectPool(dialect: PostgresDialect, pool: postgres.Sql): void {
	(dialect as unknown as Record<string, unknown>).pool = pool;
}

function storedRow(format: number): ManifestRow {
	return {
		wheel_sha256: Buffer.from(wheelHash(0x42)),
		manifest_format: format,
		name: "certifi",
		version: "2024.7.4",
		file_count: 7,
		total_bytes: "12345",
	};
}

describe("PostgresDialect.lookupManifest", () => {
	it("returns the decoded manifest when the stored row matches the format", async () => {
		const fake = makeFakePool(storedRow(MANIFEST_FORMAT));
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		const found = await dialect.lookupManifest(wheelHash(0x42), MANIFEST_FORMAT);

		expect(found).toEqual({
			wheelSha256: wheelHash(0x42),
			manifestFormat: MANIFEST_FORMAT,
			name: "certifi",
			version: "2024.7.4",
			fileCount: 7,
			totalBytes: 12345,
		});
	});

	it("treats a row written in a different manifest_format as a miss", async () => {
		const fake = makeFakePool(storedRow(MANIFEST_FORMAT - 1));
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		const found = await dialect.lookupManifest(wheelHash(0x42), MANIFEST_FORMAT);

		expect(found).toBeUndefined();
	});

	it("returns undefined when no row exists for the wheel", async () => {
		const fake = makeFakePool(undefined);
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		expect(await dialect.lookupManifest(wheelHash(0x99), MANIFEST_FORMAT)).toBeUndefined();
	});

	it("binds the wheel hash and the format as parameters, not as SQL text", async () => {
		const fake = makeFakePool(storedRow(MANIFEST_FORMAT));
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		await dialect.lookupManifest(wheelHash(0x42), MANIFEST_FORMAT);

		expect(fake.statements).toEqual([
			"SELECT wheel_sha256, manifest_format, name, version, file_count, total_bytes FROM package_manifests WHERE wheel_sha256 = ? AND manifest_format = ?",
		]);
		expect(fake.params[0]).toEqual([Buffer.from(wheelHash(0x42)), MANIFEST_FORMAT]);
	});
});

describe("PostgresDialect.loadManifestFiles / touchManifests", () => {
	it("issues no statement for an empty wheel list", async () => {
		const fake = makeFakePool(undefined);
		const dialect = new PostgresDialect("postgres://stub");
		injectPool(dialect, fake.pool);

		expect(await dialect.loadManifestFiles([])).toEqual(new Map());
		await dialect.touchManifests([]);

		expect(fake.statements).toEqual([]);
	});
});
