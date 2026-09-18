/**
 * Phase P of the install pipeline, plus the three ledger-only commands.
 *
 * `publishInstall` is the only step that touches the sandbox tree. It runs
 * inside the script transaction, issues no network request and inflates
 * nothing: every byte it links is already in `blobs`, and every path it links is
 * already in `package_manifest_files`. It checks `ctx.signal.aborted` before its
 * first statement, does all of its refusals (ownership, quota) before any
 * mutation, and writes the ledger row last so a publish interrupted part-way
 * leaves no record and is repaired by re-running the same `pip install`.
 */

import type { CommandContext } from "just-bash";
import type { IPackageStore } from "../../sql-fs/package-store.js";
import type { GraftFile, SandboxPackageRow } from "../../sql-fs/types.js";
import { PACKAGE_LIMIT_ENV, type PackageLimits } from "./package-limits.js";
import { SITE_PACKAGES, fail, normalizePackageName } from "./pip-shared.js";

/** One wheel this install is publishing into the sandbox. */
export interface IncomingWheel {
	readonly name: string;
	readonly version: string;
	readonly wheelSha256: Uint8Array;
}

export interface PublishOptions {
	readonly ctx: CommandContext;
	readonly store: IPackageStore;
	readonly incoming: readonly IncomingWheel[];
	readonly limits: PackageLimits;
	/** Writes the synthetic `requests` overlay, when the provider was used. */
	readonly compatOverlay?: () => Promise<void>;
}

export interface PublishResult {
	/** Lines for stdout: kept-modified files and already-satisfied packages. */
	readonly notes: readonly string[];
	/** Every file row now owned by this sandbox's incoming wheels. */
	readonly grafted: readonly GraftFile[];
}

/**
 * Raised when `bulkGraft` reports a collected blob. Carries the wheels whose
 * manifests are stale, so the caller can delete them, redo Phase W and retry
 * the publish once.
 */
export class StaleManifestError extends Error {
	readonly code = "PIP_STALE_MANIFEST";
	readonly wheels: readonly string[];

	constructor(wheels: readonly string[]) {
		super(`stale package manifests: ${wheels.join(", ")}`);
		this.wheels = wheels;
	}
}

export function hex(hash: Uint8Array): string {
	return Buffer.from(hash).toString("hex");
}

function sameHash(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
	if (left === undefined || right === undefined) return false;
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
	return true;
}

interface Owned {
	readonly package: string;
	readonly sha256: Uint8Array;
	readonly mode: number;
}

/**
 * Removes the paths a departing wheel owned alone, leaving anything the sandbox
 * has edited in place. Returns the "kept modified file" notes.
 */
async function removeOwnedPaths(
	ctx: CommandContext,
	store: IPackageStore,
	files: readonly GraftFile[],
	stillOwned: ReadonlyMap<string, Owned>,
): Promise<string[]> {
	const notes: string[] = [];
	const touchedDirs = new Set<string>();
	for (const file of files) {
		if (stillOwned.has(file.path)) continue;
		const current = await store.contentHashAt(file.path);
		if (current === undefined) continue;
		if (!sameHash(current, file.sha256)) {
			notes.push(`kept modified file ${file.path}`);
			continue;
		}
		await ctx.fs.rm(file.path, { force: true });
		let dir = file.path.slice(0, file.path.lastIndexOf("/"));
		while (dir.startsWith(`${SITE_PACKAGES}/`)) {
			touchedDirs.add(dir);
			dir = dir.slice(0, dir.lastIndexOf("/"));
		}
	}
	// Deepest first, so a directory emptied by its children's removal is seen
	// after they are gone.
	for (const dir of [...touchedDirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
		if (!(await ctx.fs.exists(dir))) continue;
		if ((await ctx.fs.readdir(dir)).length > 0) continue;
		await ctx.fs.rm(dir, { force: true });
	}
	return notes;
}

/** The seven-step, DB-only publish. Every refusal happens before any mutation. */
export async function publishInstall(options: PublishOptions): Promise<PublishResult> {
	const { ctx, store, incoming, limits } = options;
	if (ctx.signal?.aborted) fail("install was cancelled before anything was written");

	// 1. Ledger plus the manifest file rows of every wheel involved.
	const ledger = await store.listInstalledPackages();
	const incomingByName = new Map(incoming.map((wheel) => [wheel.name, wheel]));
	const wheelSet = new Map<string, Uint8Array>();
	for (const row of [...ledger, ...incoming]) wheelSet.set(hex(row.wheelSha256), row.wheelSha256);
	const manifestFiles = await store.loadManifestFiles([...wheelSet.values()]);

	// The post-install set: everything the ledger keeps, plus everything coming in.
	const postInstall = new Map<string, SandboxPackageRow>();
	for (const row of ledger) postInstall.set(row.name, row);
	for (const wheel of incoming) {
		postInstall.set(wheel.name, { name: wheel.name, version: wheel.version, wheelSha256: wheel.wheelSha256 });
	}

	/** One wheel's manifest rows; the hash is hexed here and nowhere else. */
	const filesOf = (wheelSha256: Uint8Array): readonly GraftFile[] => manifestFiles.get(hex(wheelSha256)) ?? [];

	// Each post-install wheel's rows, looked up once and reused by every step below.
	const planned = [...postInstall.values()].map((row) => ({ row, files: filesOf(row.wheelSha256) }));

	// 1b. Every incoming wheel must have manifest rows; a missing manifest means
	// GC collected it between Phase W and Phase P.
	for (const wheel of incoming) {
		if (filesOf(wheel.wheelSha256).length === 0) {
			fail(
				`package manifest for ${wheel.name}-${wheel.version} is missing (may have been collected); retry the install`,
			);
		}
	}

	// 2. Ownership (two packages may share a path only when the bytes are
	// identical) and 3. quota, both over the post-install set. An ownership
	// conflict is refused where it is found, the quota once the totals are in.
	const owners = new Map<string, Owned>();
	let quotaFiles = 0;
	let quotaBytes = 0;
	for (const { row, files } of planned) {
		for (const file of files) {
			const existing = owners.get(file.path);
			if (existing === undefined) {
				quotaFiles += 1;
				quotaBytes += file.size;
				owners.set(file.path, { package: row.name, sha256: file.sha256, mode: file.mode });
				continue;
			}
			if (existing.package !== row.name) {
				if (!sameHash(existing.sha256, file.sha256) || existing.mode !== file.mode) {
					fail(`${existing.package} and ${row.name} both provide '${file.path}' with different contents or modes`);
				}
			}
		}
	}
	if (quotaBytes > limits.sandboxQuotaBytes) {
		fail(
			`installed packages would use ${quotaBytes} bytes, over this sandbox's ${limits.sandboxQuotaBytes} byte limit (${PACKAGE_LIMIT_ENV.sandboxQuotaBytes})`,
		);
	}
	if (quotaFiles > limits.sandboxMaxFiles) {
		fail(
			`installed packages would use ${quotaFiles} files, over this sandbox's ${limits.sandboxMaxFiles} file limit (${PACKAGE_LIMIT_ENV.sandboxMaxFiles})`,
		);
	}

	const notes: string[] = [];

	// 4. Superseded versions: drop what the old wheel owned alone and still matches.
	for (const row of ledger) {
		const replacement = incomingByName.get(row.name);
		if (replacement === undefined || sameHash(replacement.wheelSha256, row.wheelSha256)) continue;
		notes.push(...(await removeOwnedPaths(ctx, store, filesOf(row.wheelSha256), owners)));
	}

	// 5. Graft. An identical (name, wheel) already in the ledger is a no-op.
	const installedByName = new Map(ledger.map((row) => [row.name, row]));
	const fresh: IncomingWheel[] = [];
	for (const wheel of incoming) {
		const existing = installedByName.get(wheel.name);
		if (existing !== undefined && sameHash(existing.wheelSha256, wheel.wheelSha256)) {
			notes.push(`already satisfied: ${wheel.name}-${wheel.version}`);
			continue;
		}
		fresh.push(wheel);
	}

	const rows: GraftFile[] = [];
	const byPath = new Set<string>();
	const wheelOfBlob = new Map<string, string>();
	for (const wheel of fresh) {
		const wheelHex = hex(wheel.wheelSha256);
		for (const file of manifestFiles.get(wheelHex) ?? []) {
			wheelOfBlob.set(hex(file.sha256), wheelHex);
			if (byPath.has(file.path)) continue;
			byPath.add(file.path);
			rows.push(file);
		}
	}

	if (rows.length > 0) {
		try {
			await store.bulkGraft(rows);
		} catch (error) {
			const missing = (error as { code?: unknown; missing?: unknown }).missing;
			if ((error as { code?: unknown }).code !== "EGRAFTMISSING" || !Array.isArray(missing)) throw error;
			const stale = new Set<string>();
			for (const blob of missing as string[]) {
				const wheelHex = wheelOfBlob.get(blob);
				if (wheelHex !== undefined) stale.add(wheelHex);
			}
			throw new StaleManifestError([...stale]);
		}
	}

	// 6. Keep every manifest in the post-install set alive for the GC TTL sweep.
	await store.touchManifests(planned.map(({ row }) => row.wheelSha256));

	// 7. The compat overlay, then the ledger — written last so an interrupted
	// publish leaves no claim on a tree that was only partly linked.
	if (options.compatOverlay !== undefined) await options.compatOverlay();
	await store.upsertInstalledPackages(
		fresh.map((wheel) => ({ name: wheel.name, version: wheel.version, wheelSha256: wheel.wheelSha256 })),
	);

	return { notes, grafted: rows };
}

/**
 * Upper bound on what the post-publish warm pulls into the content cache. Small
 * enough that a cold `databricks --version` is not paid file by file, small
 * enough not to evict the sandbox's own files. To be tuned once cold and warm
 * runs are measured on a fresh session.
 */
export const CONTENT_WARM_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** Per-file ceiling for the same warm. */
export const CONTENT_WARM_MAX_FILE_BYTES = 64 * 1024;

/** Files read concurrently per round. The byte budget is charged per chunk. */
const CONTENT_WARM_CHUNK = 16;

/**
 * Reads the small interpreted files of a fresh install back through the normal
 * `readFile` path, which fills the in-memory content cache and backfills Redis.
 * Best effort: a read that fails here must not fail the install.
 *
 * Reads go out a chunk at a time, so the budget is only checked between chunks
 * and one round may overshoot it by at most a chunk's worth of small files.
 */
export async function warmContentCache(ctx: CommandContext, files: readonly GraftFile[]): Promise<void> {
	const wanted = files.filter(
		(file) =>
			file.size <= CONTENT_WARM_MAX_FILE_BYTES && (file.path.endsWith(".py") || file.path.includes(".dist-info/")),
	);
	let budget = CONTENT_WARM_MAX_TOTAL_BYTES;
	for (let start = 0; start < wanted.length && budget > 0; start += CONTENT_WARM_CHUNK) {
		const chunk = wanted.slice(start, start + CONTENT_WARM_CHUNK);
		await Promise.all(
			chunk.map(async (file) => {
				try {
					await ctx.fs.readFileBuffer(file.path);
				} catch {
					// Best effort: a file that cannot be read is simply not warmed.
				}
			}),
		);
		for (const file of chunk) budget -= file.size;
	}
}

export interface UninstallResult {
	readonly removed: SandboxPackageRow | undefined;
	readonly notes: readonly string[];
}

/** Removes one package's ledger row and the paths it owned alone. */
export async function uninstallPackage(
	ctx: CommandContext,
	store: IPackageStore,
	requested: string,
): Promise<UninstallResult> {
	const wanted = normalizePackageName(requested);
	const ledger = await store.listInstalledPackages();
	const target = ledger.find((row) => normalizePackageName(row.name) === wanted);
	if (target === undefined) return { removed: undefined, notes: [] };

	const remaining = ledger.filter((row) => row !== target);
	const manifestFiles = await store.loadManifestFiles(ledger.map((row) => row.wheelSha256));
	const stillOwned = new Map<string, Owned>();
	for (const row of remaining) {
		for (const file of manifestFiles.get(hex(row.wheelSha256)) ?? []) {
			stillOwned.set(file.path, { package: row.name, sha256: file.sha256, mode: file.mode });
		}
	}
	const notes = await removeOwnedPaths(ctx, store, manifestFiles.get(hex(target.wheelSha256)) ?? [], stillOwned);
	await store.deleteInstalledPackage(target.name);
	return { removed: target, notes };
}

/** `pip list` — the same two-column table real pip prints. */
export function formatPackageList(rows: readonly SandboxPackageRow[]): string {
	if (rows.length === 0) return "";
	const sorted = [...rows].sort((a, b) => normalizePackageName(a.name).localeCompare(normalizePackageName(b.name)));
	const nameWidth = Math.max(7, ...sorted.map((row) => row.name.length));
	const versionWidth = Math.max(7, ...sorted.map((row) => row.version.length));
	const lines = [
		`${"Package".padEnd(nameWidth)} ${"Version".padEnd(versionWidth)}`,
		`${"-".repeat(nameWidth)} ${"-".repeat(versionWidth)}`,
		...sorted.map((row) => `${row.name.padEnd(nameWidth)} ${row.version.padEnd(versionWidth)}`.trimEnd()),
	];
	return `${lines.join("\n")}\n`;
}

/** `pip freeze` — `name==version`, sorted. */
export function formatFreeze(rows: readonly SandboxPackageRow[]): string {
	if (rows.length === 0) return "";
	return `${[...rows]
		.sort((a, b) => normalizePackageName(a.name).localeCompare(normalizePackageName(b.name)))
		.map((row) => `${row.name}==${row.version}`)
		.join("\n")}\n`;
}
