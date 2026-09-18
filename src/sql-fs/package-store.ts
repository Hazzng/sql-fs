/**
 * `IPackageStore` — the narrow surface a package installer needs from the
 * filesystem object it is handed as `ctx.fs`.
 *
 * Why a facade rather than reaching for the dialect: a just-bash custom command
 * only ever sees `ctx.fs`, and `SqlFs` is the only class that is allowed to know
 * which dialect it talks to (CLAUDE.md). Rather than leaking a `SqlDialect` into
 * `src/api/commands`, `SqlFs` implements this interface and the installer
 * duck-types it out of `ctx.fs` with {@link asPackageStore} — the same shape
 * `routes/ingest.ts` uses for `bulkIngest`.
 *
 * Two transaction regimes are mixed here deliberately, and each method says
 * which one it is in:
 *
 * - **Pool-level, self-committing** (`ingestBlobs`, `lookupManifest`,
 *   `recordManifest`, `deleteManifest`, `loadManifestFiles`, `touchManifests`):
 *   tenant-global CAS tables with no `sandbox_id` and no RLS. They commit
 *   independently of the script transaction so the work survives a later
 *   rollback and is reusable by every other sandbox.
 * - **Inside the script transaction** (`bulkGraft`, the ledger trio, and any
 *   `rm` the caller issues): sandbox-scoped, RLS-protected, atomic with the rest
 *   of the script.
 */

import type { GraftFile, PackageManifest, SandboxPackageRow } from "./types.js";

/** One content-addressed blob handed to {@link IPackageStore.ingestBlobs}. */
export interface PackageBlob {
	readonly sha256: Uint8Array;
	readonly data: Uint8Array;
}

export interface IPackageStore {
	// ── Tenant-global, self-committing ────────────────────────────────────────

	/** Commits a batch of CAS blobs outside any caller transaction. */
	ingestBlobs(blobs: readonly PackageBlob[]): Promise<void>;

	/** The manifest for this wheel in this format, or undefined (a miss). */
	lookupManifest(wheelSha256: Uint8Array, manifestFormat: number): Promise<PackageManifest | undefined>;

	/**
	 * Records (or replaces) one wheel's manifest. Throws `EGRAFTMISSING` and
	 * writes nothing when a referenced blob is no longer stored.
	 */
	recordManifest(manifest: PackageManifest, files: readonly GraftFile[]): Promise<void>;

	/** Deletes a stale manifest. Throws `EMANIFESTINUSE` if a ledger row holds it. */
	deleteManifest(wheelSha256: Uint8Array): Promise<void>;

	/** File rows per wheel, keyed by the wheel hash as lowercase hex. */
	loadManifestFiles(wheelSha256s: readonly Uint8Array[]): Promise<Map<string, GraftFile[]>>;

	/** Bumps `last_used_at` so the manifest GC TTL sweep keeps these wheels. */
	touchManifests(wheelSha256s: readonly Uint8Array[]): Promise<void>;

	// ── Sandbox-scoped, inside the script transaction ─────────────────────────

	/** Links already-stored content into this sandbox; no payload is sent. */
	bulkGraft(files: readonly GraftFile[]): Promise<void>;

	/** The installed-package ledger for this sandbox, ordered by name. */
	listInstalledPackages(): Promise<SandboxPackageRow[]>;

	/** Inserts or replaces ledger rows for this sandbox. */
	upsertInstalledPackages(rows: readonly SandboxPackageRow[]): Promise<void>;

	/** Removes one ledger row by the exact stored package name. */
	deleteInstalledPackage(name: string): Promise<void>;

	// ── Cache-served ──────────────────────────────────────────────────────────

	/**
	 * The `content_sha256` of the inode currently at `path`, or undefined when
	 * there is no file there. `SqlFs` serves it from the path cache, so it costs
	 * nothing; the uninstall and supersede paths use it to tell an untouched
	 * package file from one the sandbox has edited. Async because a backend
	 * without a path cache has to read to answer.
	 */
	contentHashAt(path: string): Promise<Uint8Array | undefined>;
}

const PACKAGE_STORE_METHODS = [
	"ingestBlobs",
	"lookupManifest",
	"recordManifest",
	"deleteManifest",
	"loadManifestFiles",
	"touchManifests",
	"bulkGraft",
	"listInstalledPackages",
	"upsertInstalledPackages",
	"deleteInstalledPackage",
	"contentHashAt",
] as const satisfies ReadonlyArray<keyof IPackageStore>;

/**
 * Duck-types a package store out of an arbitrary filesystem object. Returns
 * undefined for backends that have no SQL behind them (the `memory` backend),
 * which is how the installer reports "requires a SQL backend" instead of
 * crashing on a missing method.
 */
export function asPackageStore(fs: unknown): IPackageStore | undefined {
	if (fs === null || typeof fs !== "object") return undefined;
	const candidate = fs as Record<string, unknown>;
	for (const method of PACKAGE_STORE_METHODS) {
		if (typeof candidate[method] !== "function") return undefined;
	}
	return fs as IPackageStore;
}
