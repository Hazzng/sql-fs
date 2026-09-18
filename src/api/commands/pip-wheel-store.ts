/**
 * Phase W of the install pipeline: make one wheel's bytes durable and reusable
 * by every sandbox in the tenant, without touching any sandbox tree.
 *
 * For each wheel, in order: take the wheel lease, look the manifest up by the
 * wheel's own sha256, and on a hit do nothing at all — no download, no inflate,
 * no blob transmission. On a miss, download once, verify the bytes against the
 * hash PyPI declared, stream the archive through the wheel reader and commit
 * each batch of blobs, then record the manifest. Both the blob inserts and the
 * manifest row are self-committing, so a failure on wheel 3 of 5 leaves wheels
 * 1 and 2 reusable and the sandbox untouched.
 *
 * Manifest paths are stored **absolute**, already prefixed with
 * `/site-packages/`. The alternative (archive-relative rows prefixed at graft
 * time) was rejected because the ownership map, the quota sum, the supersede
 * diff and `bulkGraft` all work in sandbox-path space; prefixing once, here, is
 * the only place that has to know the install root. `MANIFEST_FORMAT` is what
 * invalidates every stored row if that root ever changes.
 */

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { MANIFEST_FORMAT } from "../../sql-fs/package-manifest.js";
import type { IPackageStore, PackageBlob } from "../../sql-fs/package-store.js";
import type { GraftFile, PackageManifest } from "../../sql-fs/types.js";
import { LockLostError, wheelLockKey, withDistributedLock } from "../distributed-lock.js";
import { logAudit } from "../lib/audit.js";
import { PACKAGE_LIMIT_ENV, type PackageLimits } from "./package-limits.js";
import { SITE_PACKAGES, type WheelTarget, fail } from "./pip-shared.js";
import { WheelError, readWheel } from "./wheel-reader.js";

/** What the lease tells its callback about the acquisition it just made. */
export interface WheelLeaseInfo {
	/**
	 * Milliseconds spent waiting for the lease. `withDistributedLock` exposes no
	 * "did you queue" flag, so the lease measures its own acquire time; anything
	 * above zero means another holder (this replica or another) was in Phase W
	 * for this wheel, which is exactly when `pip_singleflight_wait` is worth
	 * emitting.
	 */
	readonly waitedMs: number;
}

/**
 * Serialises the Phase W work for one wheel hash so two concurrent installs of
 * the same wheel do the download once. The in-process default covers one
 * replica; `createRedisWheelLease` covers a fleet. The contract is the same
 * either way, which is why it is an injected option rather than a hard-wired
 * call.
 */
export type WheelLease = <T>(sha256hex: string, fn: (info: WheelLeaseInfo) => Promise<T>) => Promise<T>;

/** Structured Phase W / Phase P log sink. Injectable so tests can assert events. */
export type PipLogger = (event: Record<string, unknown>) => void;

/** Default sink: one JSON line per event, `event` last, as everywhere else in `src/api`. */
export const logPipEvent: PipLogger = (event) => {
	const { event: name, ...fields } = event;
	logAudit(String(name), fields);
};

/**
 * Per-replica singleflight: the second caller for a hash waits, then finds the
 * manifest recorded and skips. Across replicas without Redis the work is simply
 * duplicated, which is correct because blob inserts are content addressed and
 * the manifest write is an upsert.
 */
export function createInProcessWheelLease(): WheelLease {
	const inFlight = new Map<string, Promise<unknown>>();
	return async <T>(key: string, fn: (info: WheelLeaseInfo) => Promise<T>): Promise<T> => {
		const previous = inFlight.get(key);
		const startedAt = Date.now();
		const call = (): Promise<T> => fn({ waitedMs: previous === undefined ? 0 : Date.now() - startedAt });
		const run = (previous ?? Promise.resolve()).then(call, call);
		// Keep the chain alive but never let a rejection escape twice.
		const link = run.then(
			() => undefined,
			() => undefined,
		);
		inFlight.set(key, link);
		try {
			return await run;
		} finally {
			// Cleared on resolve and on reject alike: a failed leader must not leave
			// an entry that makes the next caller wait on a promise nobody will run.
			if (inFlight.get(key) === link) inFlight.delete(key);
		}
	};
}

export interface RedisWheelLeaseOptions {
	readonly redis: Redis;
	readonly tenantId: string;
}

/**
 * Cross-replica singleflight on `vfs:{tenant}:pip:wheel:{sha256hex}`, with the
 * lock module's defaults (60 s lease, 20 s renewal, compare-and-delete release).
 *
 * The lease covers exactly one wheel's Phase W — the manifest re-check, the
 * download, the blob ingest and the manifest write — and is released before the
 * install loop moves to the next wheel, so two sandboxes installing overlapping
 * closures in different orders can never hold one another's next lock.
 *
 * A definitive ownership loss surfaces as `LockLostError`, which `prepareWheel`
 * turns into a `PipError` naming the wheel. Nothing needs undoing: blob rows are
 * content addressed and the manifest is written last, so a lost lease leaves at
 * worst some reusable blobs behind.
 */
export function createRedisWheelLease(options: RedisWheelLeaseOptions): WheelLease {
	const { redis, tenantId } = options;
	return <T>(sha256hex: string, fn: (info: WheelLeaseInfo) => Promise<T>): Promise<T> => {
		const startedAt = Date.now();
		// An uncontended acquire still costs a Redis round trip, so elapsed time
		// alone would report a wait on every cold install. `onContended` fires only
		// when a SET actually lost the race, which is the real signal.
		let contended = false;
		return withDistributedLock(
			redis,
			wheelLockKey(tenantId, sha256hex),
			() => fn({ waitedMs: contended ? Date.now() - startedAt : 0 }),
			{
				onContended: () => {
					contended = true;
				},
			},
		);
	};
}

/** Cumulative budget for one `pip install`, charged across every wheel. */
export interface InstallBudget {
	downloadBytes: number;
	files: number;
	bytes: number;
}

export function createInstallBudget(): InstallBudget {
	return { downloadBytes: 0, files: 0, bytes: 0 };
}

export interface PrepareWheelOptions {
	readonly store: IPackageStore;
	readonly target: WheelTarget;
	readonly limits: PackageLimits;
	readonly budget: InstallBudget;
	readonly lease: WheelLease;
	/** Downloads the `.whl`. Called at most twice (once per Phase W attempt). */
	readonly download: () => Promise<Uint8Array>;
	/**
	 * Skip the manifest lookup and redo the work unconditionally. Used by the
	 * stale-manifest recovery path, where the recorded manifest is exactly what
	 * must not be trusted.
	 */
	readonly force?: boolean;
	/** Structured event sink; defaults to one JSON line per event. */
	readonly log?: PipLogger;
}

function hexToBytes(hex: string): Uint8Array {
	return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Charges the extracted totals and refuses past the per-install caps. */
function chargeExtracted(budget: InstallBudget, files: number, bytes: number, limits: PackageLimits): void {
	budget.files += files;
	budget.bytes += bytes;
	if (budget.files > limits.maxInstallFiles) {
		fail(`install exceeds ${limits.maxInstallFiles} files (${PACKAGE_LIMIT_ENV.maxInstallFiles})`);
	}
	if (budget.bytes > limits.maxInstallBytes) {
		fail(`install exceeds ${limits.maxInstallBytes} extracted bytes (${PACKAGE_LIMIT_ENV.maxInstallBytes})`);
	}
}

/**
 * Reads the whole wheel, ingesting each batch of blobs as it is produced, and
 * returns the manifest file rows (metadata only — no content is retained).
 */
async function ingestWheel(
	store: IPackageStore,
	wheel: Uint8Array,
	limits: PackageLimits,
	budget: InstallBudget,
): Promise<{ files: GraftFile[]; fileCount: number; totalBytes: number }> {
	const files: GraftFile[] = [];
	const reader = readWheel(wheel, {
		limits,
		consumedFiles: budget.files,
		consumedBytes: budget.bytes,
	});
	let next = await reader.next();
	while (next.done !== true) {
		const batch = next.value;
		const blobs: PackageBlob[] = batch.map((file) => ({ sha256: file.sha256, data: file.content }));
		await store.ingestBlobs(blobs);
		for (const file of batch) {
			files.push({
				path: `${SITE_PACKAGES}/${file.path}`,
				sha256: file.sha256,
				mode: file.mode,
				size: file.size,
			});
		}
		next = await reader.next();
	}
	const info = next.value;
	return { files, fileCount: info.fileCount, totalBytes: info.totalBytes };
}

async function readOrFail<T>(target: WheelTarget, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (!(error instanceof WheelError)) throw error;
		return fail(`${target.name} ${target.version}: ${error.message}`);
	}
}

function isGraftMissing(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "EGRAFTMISSING";
}

/**
 * Ensures the tenant holds a current manifest for this wheel, and returns it.
 * Holds at most one wheel buffer, released before the caller moves to the next
 * wheel.
 *
 * Events, all carrying the wheel hash, the package, the file count, the byte
 * total and the elapsed time inside the lease: `pip_singleflight_wait` first
 * when the acquire actually queued behind another holder, then exactly one of
 * `pip_manifest_hit` or `pip_manifest_miss`. The miss is emitted after the work
 * rather than at the lookup because the counts it reports only exist once the
 * archive has been read.
 */
export async function prepareWheel(options: PrepareWheelOptions): Promise<PackageManifest> {
	const { store, target, limits, budget, lease, download } = options;
	const log = options.log ?? logPipEvent;
	const wheelSha256 = hexToBytes(target.sha256);
	const base = { wheel: target.sha256, name: target.name, version: target.version };

	try {
		return await lease(target.sha256, async (info) => {
			const startedAt = Date.now();
			const emit = (event: string, fileCount: number, bytes: number): void => {
				const elapsedMs = Date.now() - startedAt;
				if (info.waitedMs > 0) {
					log({ event: "pip_singleflight_wait", ...base, fileCount, bytes, elapsedMs, waitedMs: info.waitedMs });
				}
				log({ event, ...base, fileCount, bytes, elapsedMs });
			};

			// Re-check under the lease: the previous holder may have just recorded it.
			const hit = options.force === true ? undefined : await store.lookupManifest(wheelSha256, MANIFEST_FORMAT);
			if (hit !== undefined) {
				chargeExtracted(budget, hit.fileCount, hit.totalBytes, limits);
				emit("pip_manifest_hit", hit.fileCount, hit.totalBytes);
				return hit;
			}

			// One wheel buffer, scoped to this lease callback: it is unreachable the
			// moment this function returns, which is before the caller starts the next
			// wheel (the install loop is sequential).
			const wheel = await download();
			budget.downloadBytes += wheel.byteLength;
			if (budget.downloadBytes > limits.maxInstallDownloadBytes) {
				fail(
					`install downloads exceed ${limits.maxInstallDownloadBytes} bytes (${PACKAGE_LIMIT_ENV.maxInstallDownloadBytes})`,
				);
			}
			if (createHash("sha256").update(wheel).digest("hex") !== target.sha256) {
				fail(`SHA-256 verification failed for ${target.name} ${target.version}`);
			}

			// Every refusal the reader raises is the installer's refusal too, named
			// after the package rather than surfacing as a generic failure.
			const read = await readOrFail(target, () => ingestWheel(store, wheel, limits, budget));
			chargeExtracted(budget, read.fileCount, read.totalBytes, limits);
			const manifest: PackageManifest = {
				wheelSha256,
				manifestFormat: MANIFEST_FORMAT,
				name: target.name,
				version: target.version,
				fileCount: read.fileCount,
				totalBytes: read.totalBytes,
			};
			try {
				await store.recordManifest(manifest, read.files);
			} catch (error) {
				if (!isGraftMissing(error)) throw error;
				// A GC pass collected a blob between our ingest and the manifest write.
				// The batches are long gone, so the whole archive is read again from the
				// buffer still in scope and every blob re-ingested; the budget is not
				// charged twice.
				await readOrFail(target, () => ingestWheel(store, wheel, limits, createInstallBudget()));
				await store.recordManifest(manifest, read.files);
			}
			emit("pip_manifest_miss", read.fileCount, read.totalBytes);
			return manifest;
		});
	} catch (error) {
		// A lost lease means another holder may now be doing this wheel's work; the
		// install refuses rather than racing it. Nothing needs undoing — blobs are
		// content addressed and the manifest is written last.
		if (error instanceof LockLostError) {
			return fail(`wheel lease lost for ${target.name} ${target.version} (${target.sha256}); try again`);
		}
		throw error;
	}
}
