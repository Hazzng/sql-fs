import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { PostgresDialect } from "./dialects/postgres.js";
import { SqlFs } from "./sql-fs.js";
import type { BulkIngestFile } from "./types.js";

interface BenchmarkCase {
	readonly label: string;
	readonly fileCount: number;
	readonly fileSizeBytes: number;
	readonly hotFileSizeBytes: number;
	readonly readyRuns: number;
	readonly warmReadRuns: number;
}

interface BenchmarkResult {
	readonly label: string;
	readonly pathCount: number;
	readonly fileCount: number;
	readonly fileSizeBytes: number;
	readonly hotFileSizeBytes: number;
	readonly seedMs: number;
	readonly readyMs: number[];
	readonly coldReadMs: number;
	readonly warmReadMs: number[];
}

const DEFAULT_CASES: readonly BenchmarkCase[] = [
	{
		label: "1k files x 1 KiB",
		fileCount: 1_000,
		fileSizeBytes: 1_024,
		hotFileSizeBytes: 1_048_576,
		readyRuns: 5,
		warmReadRuns: 25,
	},
	{
		label: "10k files x 1 KiB",
		fileCount: 10_000,
		fileSizeBytes: 1_024,
		hotFileSizeBytes: 1_048_576,
		readyRuns: 3,
		warmReadRuns: 25,
	},
];
const BULK_INGEST_BATCH_SIZE = 2_000;

function parseCases(argv: readonly string[]): readonly BenchmarkCase[] {
	const filesArg = argv.find((arg) => arg.startsWith("--files="));
	if (!filesArg) return DEFAULT_CASES;

	const fileCounts = filesArg
		.slice("--files=".length)
		.split(",")
		.map((value) => Number(value.trim()))
		.filter((value) => Number.isFinite(value) && value > 0);

	if (fileCounts.length === 0) {
		throw new Error("Expected at least one positive integer in --files=...");
	}

	const fileSizeBytes = readNumberArg(argv, "--file-size-bytes", 1_024);
	const hotFileSizeBytes = readNumberArg(argv, "--hot-file-size-bytes", 1_048_576);
	const readyRuns = readNumberArg(argv, "--ready-runs", 3);
	const warmReadRuns = readNumberArg(argv, "--warm-read-runs", 25);

	return fileCounts.map((fileCount) => ({
		label: `${fileCount.toLocaleString()} files x ${formatBytes(fileSizeBytes)}`,
		fileCount,
		fileSizeBytes,
		hotFileSizeBytes,
		readyRuns,
		warmReadRuns,
	}));
}

function readNumberArg(argv: readonly string[], prefix: string, fallback: number): number {
	const arg = argv.find((value) => value.startsWith(`${prefix}=`));
	if (!arg) return fallback;
	const parsed = Number(arg.slice(prefix.length + 1));
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Expected a positive number for ${prefix}`);
	}
	return parsed;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

function stats(values: readonly number[]): { min: number; avg: number; max: number } {
	const min = Math.min(...values);
	const max = Math.max(...values);
	const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
	return { min, avg, max };
}

async function timeMs<T>(fn: () => Promise<T>): Promise<{ elapsedMs: number; value: T }> {
	const start = performance.now();
	const value = await fn();
	return {
		elapsedMs: performance.now() - start,
		value,
	};
}

function buildFiles(caseDef: BenchmarkCase): readonly BulkIngestFile[] {
	const files: BulkIngestFile[] = [];
	const directoryCount = Math.max(10, Math.ceil(caseDef.fileCount / 200));

	for (let i = 0; i < caseDef.fileCount; i++) {
		const dirIdx = i % directoryCount;
		const subDirIdx = Math.floor(i / directoryCount) % 20;
		const path = `/bench/dir-${dirIdx}/sub-${subDirIdx}/file-${i}.txt`;
		files.push({
			path,
			content: createAsciiContent(caseDef.fileSizeBytes, `file-${i}`),
			mode: 0o644,
		});
	}

	files.push({
		path: "/bench/hot/hot-file.bin",
		content: createBinaryPattern(caseDef.hotFileSizeBytes),
		mode: 0o644,
	});

	return files;
}

function createAsciiContent(size: number, label: string): Uint8Array {
	const prefix = `${label}:`;
	const output = new Uint8Array(size);
	const prefixBytes = new TextEncoder().encode(prefix);
	for (let i = 0; i < output.length; i++) {
		output[i] = prefixBytes[i % prefixBytes.length] ?? 0x78;
	}
	return output;
}

function createBinaryPattern(size: number): Uint8Array {
	const output = new Uint8Array(size);
	for (let i = 0; i < output.length; i++) {
		output[i] = i % 251;
	}
	return output;
}

async function applyPostgresMigrations(dialect: PostgresDialect): Promise<void> {
	const migrationPaths = [
		fileURLToPath(new URL("./migrations/postgres/0000_create_tables.sql", import.meta.url)),
		fileURLToPath(new URL("./migrations/postgres/0001_rls_and_procs.sql", import.meta.url)),
	] as const;

	for (const migrationPath of migrationPaths) {
		const sql = readFileSync(migrationPath, "utf8");
		await dialect.transaction(async (tx) => {
			await tx.unsafe(sql);
		});
	}
}

async function seedSandbox(
	dialect: PostgresDialect,
	sandboxId: string,
	files: readonly BulkIngestFile[],
): Promise<number> {
	const seeded = await timeMs(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.createSandbox(tx, sandboxId);
		});
		for (let start = 0; start < files.length; start += BULK_INGEST_BATCH_SIZE) {
			const chunk = files.slice(start, start + BULK_INGEST_BATCH_SIZE);
			await dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, sandboxId);
				await dialect.bulkIngest(tx, chunk);
			});
		}
	});
	return seeded.elapsedMs;
}

async function measureCase(dialect: PostgresDialect, caseDef: BenchmarkCase): Promise<BenchmarkResult> {
	const sandboxId = `bench-${Date.now()}-${randomUUID()}`;
	const files = buildFiles(caseDef);
	const hotFilePath = "/bench/hot/hot-file.bin";

	try {
		const seedMs = await seedSandbox(dialect, sandboxId, files);

		const readyMs: number[] = [];
		let pathCount = 0;
		for (let i = 0; i < caseDef.readyRuns; i++) {
			const fs = new SqlFs({ dialect, sandboxId });
			const ready = await timeMs(async () => {
				await fs.ready();
			});
			readyMs.push(ready.elapsedMs);
			pathCount = fs.getAllPaths().length;
		}

		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();

		const coldRead = await timeMs(async () => {
			return await fs.readFileBuffer(hotFilePath);
		});
		const warmReadMs: number[] = [];
		for (let i = 0; i < caseDef.warmReadRuns; i++) {
			const warmRead = await timeMs(async () => {
				return await fs.readFileBuffer(hotFilePath);
			});
			warmReadMs.push(warmRead.elapsedMs);
		}

		return {
			label: caseDef.label,
			pathCount,
			fileCount: caseDef.fileCount,
			fileSizeBytes: caseDef.fileSizeBytes,
			hotFileSizeBytes: caseDef.hotFileSizeBytes,
			seedMs,
			readyMs,
			coldReadMs: coldRead.elapsedMs,
			warmReadMs,
		};
	} finally {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
	}
}

function printResults(results: readonly BenchmarkResult[]): void {
	console.log("");
	console.log("SqlFs cache benchmark");
	console.log("=====================");

	for (const result of results) {
		const ready = stats(result.readyMs);
		const warm = stats(result.warmReadMs);
		console.log("");
		console.log(`Case: ${result.label}`);
		console.log(`  Files seeded:     ${result.fileCount.toLocaleString()} + 1 hot file`);
		console.log(`  File size:        ${formatBytes(result.fileSizeBytes)}`);
		console.log(`  Hot file size:    ${formatBytes(result.hotFileSizeBytes)}`);
		console.log(`  Paths loaded:     ${result.pathCount.toLocaleString()}`);
		console.log(`  Seed time:        ${result.seedMs.toFixed(2)} ms`);
		console.log(
			`  ready() ms:       avg ${ready.avg.toFixed(2)} | min ${ready.min.toFixed(2)} | max ${ready.max.toFixed(2)}`,
		);
		console.log(`  Cold read ms:     ${result.coldReadMs.toFixed(2)}`);
		console.log(
			`  Warm read ms:     avg ${warm.avg.toFixed(4)} | min ${warm.min.toFixed(4)} | max ${warm.max.toFixed(4)}`,
		);
	}
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}

	const cases = parseCases(process.argv.slice(2));
	const dialect = new PostgresDialect(databaseUrl);

	await dialect.connect();
	try {
		await applyPostgresMigrations(dialect);
		const results: BenchmarkResult[] = [];
		for (const caseDef of cases) {
			console.log(`Running case: ${caseDef.label}`);
			results.push(await measureCase(dialect, caseDef));
		}
		printResults(results);
	} finally {
		await dialect.disconnect();
	}
}

await main();
