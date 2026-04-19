/**
 * Comparison test fixture runner.
 *
 * Drop-in replacement for just-bash's fixture-runner that adds SqlFs support:
 * when FS_BACKEND=postgres and DATABASE_URL are set, setupFiles creates a
 * SqlFs-backed Bash instance instead of the default InMemoryFs-backed one.
 *
 * US-103: run just-bash comparison tests with SqlFs
 */

import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Bash, getCommandNames } from "just-bash";
import { PostgresDialect } from "../fs/sql-fs/dialects/postgres.js";
import { SqlFs } from "../fs/sql-fs/sql-fs.js";

const execAsync: (
	command: string,
	options?: { cwd?: string; shell?: string },
) => Promise<{ stdout: string; stderr: string }> = promisify(exec);

// ---------------------------------------------------------------------------
// SqlFs backend detection
// ---------------------------------------------------------------------------

const useSqlFs = process.env.FS_BACKEND === "postgres" && !!process.env.DATABASE_URL;

// Shared dialect — one connection pool per test run
let sharedDialect: PostgresDialect | null = null;

async function getDialect(): Promise<PostgresDialect> {
	if (!sharedDialect) {
		sharedDialect = new PostgresDialect(process.env.DATABASE_URL as string);
		await sharedDialect.connect();
	}
	return sharedDialect;
}

/**
 * Pre-populate system paths that Bash's initFilesystem would normally create
 * synchronously via mkdirSync/writeFileSync (which SqlFs does not expose).
 * Also creates the given testDir inside the virtual FS.
 */
async function initSqlFsSystemPaths(sqlFs: SqlFs, testDir: string): Promise<void> {
	// /bin and /tmp and /home/user already exist from createSandbox.
	// Create remaining standard paths that Bash expects.
	await sqlFs.mkdir("/usr/bin", { recursive: true });
	await sqlFs.mkdir("/dev", { recursive: true });
	// Write minimal device file stubs
	for (const dev of ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]) {
		await sqlFs.writeFile(dev, "");
	}
	await sqlFs.mkdir("/proc/self/fd", { recursive: true });
	await sqlFs.writeFile("/proc/version", "Linux version 5.15.0-generic\n");
	await sqlFs.writeFile("/proc/self/exe", "/bin/bash");
	await sqlFs.writeFile("/proc/self/cmdline", "bash\0");
	await sqlFs.writeFile("/proc/self/comm", "bash\n");
	await sqlFs.writeFile(
		"/proc/self/status",
		"Name:\tbash\nPid:\t1\nPPid:\t0\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n",
	);
	await sqlFs.writeFile("/proc/self/fd/0", "/dev/stdin");
	await sqlFs.writeFile("/proc/self/fd/1", "/dev/stdout");
	await sqlFs.writeFile("/proc/self/fd/2", "/dev/stderr");
	// Write command stubs for all registered just-bash commands.
	// Bash writes these via writeFileSync (which SqlFs lacks), so we do it async here.
	for (const name of getCommandNames()) {
		const stub = `#!/bin/bash\n# Built-in command: ${name}\n`;
		await sqlFs.writeFile(`/bin/${name}`, stub);
		await sqlFs.writeFile(`/usr/bin/${name}`, stub);
	}
	// Create the test dir
	await sqlFs.mkdir(testDir, { recursive: true });
}

// Map testDir → sandboxId for cleanup
const sandboxRegistry = new Map<string, string>();

// ---------------------------------------------------------------------------
// Fixture recording/playback infrastructure (copied from just-bash)
// ---------------------------------------------------------------------------

export const isRecordMode: boolean = process.env.RECORD_FIXTURES === "1" || process.env.RECORD_FIXTURES === "force";

const isForceRecordMode: boolean = process.env.RECORD_FIXTURES === "force";

export interface FixtureEntry {
	command: string;
	files: Record<string, string>;
	stdout: string;
	stderr: string;
	exitCode: number;
	locked?: boolean;
}

export interface FixturesFile {
	[fixtureId: string]: FixtureEntry;
}

const fixturesCache = new Map<string, FixturesFile>();
const pendingFixtures = new Map<string, FixturesFile>();
const setupFilesRegistry = new Map<string, Record<string, string>>();

function generateFixtureId(command: string, files: Record<string, string>): string {
	const sortedFiles = Object.keys(files)
		.sort()
		.map((k) => `${k}:${files[k]}`)
		.join("|");
	const content = `${command}|||${sortedFiles}`;
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function getFixturesPath(testFile: string): string {
	const dir = path.dirname(testFile);
	const base = path.basename(testFile, ".test.ts");
	return path.join(dir, "fixtures", `${base}.fixtures.json`);
}

async function loadFixtures(testFile: string): Promise<FixturesFile> {
	const cached = fixturesCache.get(testFile);
	if (cached) return cached;

	const fixturesPath = getFixturesPath(testFile);
	try {
		const content = await fs.readFile(fixturesPath, "utf-8");
		const fixtures = JSON.parse(content) as FixturesFile;
		fixturesCache.set(testFile, fixtures);
		return fixtures;
	} catch {
		const empty: FixturesFile = Object.create(null);
		fixturesCache.set(testFile, empty);
		return empty;
	}
}

const skippedLockedFixtures: Array<{
	testFile: string;
	fixtureId: string;
	command: string;
}> = [];

async function recordFixture(testFile: string, fixtureId: string, entry: FixtureEntry): Promise<boolean> {
	if (!isForceRecordMode) {
		const existingFixtures = await loadFixtures(testFile);
		const existing = existingFixtures[fixtureId];
		if (existing?.locked) {
			skippedLockedFixtures.push({ testFile, fixtureId, command: entry.command });
			return false;
		}
	}

	let fixtures = pendingFixtures.get(testFile);
	if (!fixtures) {
		fixtures = {};
		pendingFixtures.set(testFile, fixtures);
	}
	fixtures[fixtureId] = entry;
	return true;
}

export async function writeAllFixtures(): Promise<void> {
	for (const [testFile, newFixtures] of pendingFixtures.entries()) {
		const fixturesPath = getFixturesPath(testFile);
		await fs.mkdir(path.dirname(fixturesPath), { recursive: true });

		let existingFixtures: FixturesFile = Object.create(null);
		try {
			const content = await fs.readFile(fixturesPath, "utf-8");
			existingFixtures = JSON.parse(content) as FixturesFile;
		} catch {
			// no existing file
		}

		const mergedFixtures = { ...existingFixtures };
		for (const [key, value] of Object.entries(newFixtures)) {
			const existing = existingFixtures[key];
			if (existing?.locked && !isForceRecordMode) continue;
			mergedFixtures[key] = value;
		}

		const sortedFixtures: FixturesFile = Object.create(null);
		for (const key of Object.keys(mergedFixtures).sort()) {
			const entry = mergedFixtures[key];
			if (entry) sortedFixtures[key] = entry;
		}

		await fs.writeFile(fixturesPath, `${JSON.stringify(sortedFixtures, null, 2)}\n`);
		console.log(`Wrote fixtures to ${fixturesPath}`);
	}

	if (skippedLockedFixtures.length > 0) {
		console.log("\n⚠️  Skipped locked fixtures (use RECORD_FIXTURES=force to override):");
		for (const { testFile, command } of skippedLockedFixtures) {
			console.log(`   - ${path.basename(testFile)}: "${command}"`);
		}
	}
}

// ---------------------------------------------------------------------------
// Test lifecycle helpers
// ---------------------------------------------------------------------------

export async function createTestDir(): Promise<string> {
	const testDir = path.join(os.tmpdir(), `bashenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(testDir, { recursive: true });
	return testDir;
}

export async function cleanupTestDir(testDir: string): Promise<void> {
	setupFilesRegistry.delete(testDir);

	if (useSqlFs) {
		const sandboxId = sandboxRegistry.get(testDir);
		if (sandboxId) {
			try {
				const dialect = await getDialect();
				await dialect.transaction(async (tx) => {
					await dialect.deleteSandbox(tx, sandboxId);
				});
			} catch {
				// best-effort cleanup
			}
			sandboxRegistry.delete(testDir);
		}
	}

	try {
		await fs.rm(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

export interface CompareOptions {
	compareStderr?: boolean;
	compareExitCode?: boolean;
	normalizeWhitespace?: boolean;
}

// ---------------------------------------------------------------------------
// setupFiles: creates Bash instance (InMemoryFs or SqlFs)
// ---------------------------------------------------------------------------

export async function setupFiles(testDir: string, files: Record<string, string>): Promise<Bash> {
	setupFilesRegistry.set(testDir, files);

	// Always create real OS files so runRealBash works
	for (const [filePath, content] of Object.entries(files)) {
		const fullPath = path.join(testDir, filePath);
		await fs.mkdir(path.dirname(fullPath), { recursive: true });
		await fs.writeFile(fullPath, content);
	}

	if (useSqlFs) {
		const sandboxId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		sandboxRegistry.set(testDir, sandboxId);

		const dialect = await getDialect();
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId);
		});

		const sqlFs = new SqlFs({ dialect, sandboxId });
		await sqlFs.ready();

		await initSqlFsSystemPaths(sqlFs, testDir);

		for (const [filePath, content] of Object.entries(files)) {
			const fullPath = path.join(testDir, filePath);
			await sqlFs.mkdir(path.dirname(fullPath), { recursive: true });
			await sqlFs.writeFile(fullPath, content);
		}

		return new Bash({ fs: sqlFs, cwd: testDir });
	}

	// Default: InMemoryFs
	const bashEnvFiles: Record<string, string> = Object.create(null);
	for (const [filePath, content] of Object.entries(files)) {
		bashEnvFiles[path.join(testDir, filePath)] = content;
	}
	return new Bash({ files: bashEnvFiles, cwd: testDir });
}

// ---------------------------------------------------------------------------
// runRealBash
// ---------------------------------------------------------------------------

export async function runRealBash(
	command: string,
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd,
			shell: "/bin/bash",
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (error: unknown) {
		const err = error as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: err.stdout || "",
			stderr: err.stderr || "",
			exitCode: err.code || 1,
		};
	}
}

// ---------------------------------------------------------------------------
// compareOutputs
// ---------------------------------------------------------------------------

function normalizeWhitespace(str: string): string {
	return str
		.split("\n")
		.map((line) => line.trim().replace(/\s+/g, " "))
		.join("\n");
}

function fileUrlToPath(url: string): string {
	if (!url) return "";
	if (url.startsWith("file://")) return url.slice(7);
	return url;
}

function getCallingTestFile(): string {
	const err = new Error();
	const stack = err.stack || "";
	const lines = stack.split("\n");

	for (const line of lines) {
		let match = line.match(/file:\/\/([^):]+\.comparison\.test\.ts)/);
		if (match?.[1]) return match[1];
		match = line.match(/\(([^):]+\.comparison\.test\.ts)/);
		if (match?.[1]) return match[1];
		match = line.match(/at\s+([^():]+\.comparison\.test\.ts)/);
		if (match?.[1]) return match[1].trim();
	}

	for (const line of lines) {
		let match = line.match(/file:\/\/([^):]+\.test\.ts)/);
		if (match?.[1]) return match[1];
		match = line.match(/\(([^):]+\.test\.ts)/);
		if (match?.[1]) return match[1];
	}

	throw new Error(`Could not determine calling test file from stack trace:\n${stack}`);
}

async function compareOutputsInternal(
	env: Bash,
	testDir: string,
	command: string,
	files: Record<string, string>,
	testFile: string,
	options?: CompareOptions,
): Promise<void> {
	const bashEnvResult = await env.exec(command);
	const fixtureId = generateFixtureId(command, files);

	let realBashStdout: string;
	let realBashStderr: string;
	let realBashExitCode: number;

	if (isRecordMode) {
		const existingFixtures = await loadFixtures(testFile);
		const existingFixture = existingFixtures[fixtureId];

		if (existingFixture?.locked && !isForceRecordMode) {
			realBashStdout = existingFixture.stdout;
			realBashStderr = existingFixture.stderr;
			realBashExitCode = existingFixture.exitCode;
			skippedLockedFixtures.push({ testFile, fixtureId, command });
		} else {
			const realBashResult = await runRealBash(command, testDir);
			realBashStdout = realBashResult.stdout;
			realBashStderr = realBashResult.stderr;
			realBashExitCode = realBashResult.exitCode;

			await recordFixture(testFile, fixtureId, {
				command,
				files,
				stdout: realBashStdout,
				stderr: realBashStderr,
				exitCode: realBashExitCode,
			});
		}
	} else {
		const fixtures = await loadFixtures(testFile);
		const fixture = fixtures[fixtureId];

		if (!fixture) {
			throw new Error(
				`No fixture found for command "${command}" with files ${JSON.stringify(files)}.\nFixture ID: ${fixtureId}\nRun with RECORD_FIXTURES=1 to record fixtures.`,
			);
		}

		realBashStdout = fixture.stdout;
		realBashStderr = fixture.stderr;
		realBashExitCode = fixture.exitCode;
	}

	let bashEnvStdout = bashEnvResult.stdout;
	let expectedStdout = realBashStdout;

	if (options?.normalizeWhitespace) {
		bashEnvStdout = normalizeWhitespace(bashEnvStdout);
		expectedStdout = normalizeWhitespace(expectedStdout);
	}

	if (bashEnvStdout !== expectedStdout) {
		throw new Error(
			`stdout mismatch for "${command}"\n` +
				`Expected (recorded bash): ${JSON.stringify(realBashStdout)}\n` +
				`Received (BashEnv):       ${JSON.stringify(bashEnvResult.stdout)}`,
		);
	}

	if (options?.compareExitCode !== false) {
		if (bashEnvResult.exitCode !== realBashExitCode) {
			throw new Error(
				`exitCode mismatch for "${command}"\n` +
					`Expected (recorded bash): ${realBashExitCode}\n` +
					`Received (BashEnv):       ${bashEnvResult.exitCode}`,
			);
		}
	}
}

export async function compareOutputs(
	env: Bash,
	testDir: string,
	command: string,
	options?: CompareOptions,
	files?: Record<string, string>,
	testFileUrl?: string,
): Promise<void> {
	const testFile = testFileUrl ? fileUrlToPath(testFileUrl) : getCallingTestFile();
	const testFiles = files || setupFilesRegistry.get(testDir) || Object.create(null);
	return compareOutputsInternal(env, testDir, command, testFiles, testFile, options);
}

export { path, fs };
