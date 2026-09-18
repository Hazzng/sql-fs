/**
 * An `InMemoryFs` that also implements `IPackageStore`, so the pip command sees
 * through `ctx.fs` exactly what `SqlFs` gives it in production: tenant-global
 * blobs and manifests, a per-sandbox ledger, and a graft that refuses when a
 * blob it needs is gone.
 *
 * The tenant-global half lives in a `PackageState` that several filesystems can
 * share, which is how a "second sandbox reuses the first one's wheel" test is
 * written without a database.
 */

import { createHash } from "node:crypto";
import { type IFileSystem, InMemoryFs } from "just-bash";
import type { IPackageStore, PackageBlob } from "../../../sql-fs/package-store.js";
import type { GraftFile, PackageManifest, SandboxPackageRow } from "../../../sql-fs/types.js";

export function hex(hash: Uint8Array): string {
	return Buffer.from(hash).toString("hex");
}

export interface PackageStateCounters {
	ingestCalls: number;
	ingestedBlobs: number;
	lookups: number;
	records: number;
	deletes: number;
	touches: number;
}

export interface PackageState {
	/** Tenant-global CAS, keyed by lowercase hex. */
	readonly blobs: Map<string, Uint8Array>;
	readonly manifests: Map<string, { manifest: PackageManifest; files: GraftFile[] }>;
	readonly counters: PackageStateCounters;
}

export function createPackageState(): PackageState {
	return {
		blobs: new Map(),
		manifests: new Map(),
		counters: { ingestCalls: 0, ingestedBlobs: 0, lookups: 0, records: 0, deletes: 0, touches: 0 },
	};
}

export interface FakePackageFs extends IFileSystem, IPackageStore {
	readonly state: PackageState;
	readonly ledger: Map<string, SandboxPackageRow>;
	/** Every path `bulkGraft` has linked, in call order. */
	readonly graftedPaths: string[];
}

function missingBlobError(missing: readonly string[]): Error {
	return Object.assign(new Error(`EGRAFTMISSING: ${missing.join(", ")}`), { code: "EGRAFTMISSING", missing });
}

/** Builds a filesystem whose package store is backed by `state`. */
export function createPackageFs(state: PackageState = createPackageState()): FakePackageFs {
	const fs = new InMemoryFs() as InMemoryFs & Record<string, unknown>;
	const ledger = new Map<string, SandboxPackageRow>();
	const graftedPaths: string[] = [];

	const store: IPackageStore = {
		async ingestBlobs(blobs: readonly PackageBlob[]): Promise<void> {
			state.counters.ingestCalls += 1;
			for (const blob of blobs) {
				state.counters.ingestedBlobs += 1;
				state.blobs.set(hex(blob.sha256), blob.data);
			}
		},
		async lookupManifest(wheelSha256: Uint8Array, manifestFormat: number): Promise<PackageManifest | undefined> {
			state.counters.lookups += 1;
			const entry = state.manifests.get(hex(wheelSha256));
			if (entry === undefined || entry.manifest.manifestFormat !== manifestFormat) return undefined;
			return entry.manifest;
		},
		async recordManifest(manifest: PackageManifest, files: readonly GraftFile[]): Promise<void> {
			state.counters.records += 1;
			const missing = files.filter((file) => !state.blobs.has(hex(file.sha256))).map((file) => hex(file.sha256));
			if (missing.length > 0) throw missingBlobError([...new Set(missing)]);
			state.manifests.set(hex(manifest.wheelSha256), { manifest, files: [...files] });
		},
		async deleteManifest(wheelSha256: Uint8Array): Promise<void> {
			state.counters.deletes += 1;
			state.manifests.delete(hex(wheelSha256));
		},
		async loadManifestFiles(wheelSha256s: readonly Uint8Array[]): Promise<Map<string, GraftFile[]>> {
			const result = new Map<string, GraftFile[]>();
			for (const wheel of wheelSha256s) {
				const entry = state.manifests.get(hex(wheel));
				if (entry !== undefined) result.set(hex(wheel), entry.files);
			}
			return result;
		},
		async touchManifests(wheelSha256s: readonly Uint8Array[]): Promise<void> {
			state.counters.touches += wheelSha256s.length;
		},
		async bulkGraft(files: readonly GraftFile[]): Promise<void> {
			const missing = [...new Set(files.filter((f) => !state.blobs.has(hex(f.sha256))).map((f) => hex(f.sha256)))];
			if (missing.length > 0) throw missingBlobError(missing);
			for (const file of files) {
				const slash = file.path.lastIndexOf("/");
				if (slash > 0) await fs.mkdir(file.path.slice(0, slash), { recursive: true });
				await fs.writeFile(file.path, state.blobs.get(hex(file.sha256))!);
				graftedPaths.push(file.path);
			}
		},
		async listInstalledPackages(): Promise<SandboxPackageRow[]> {
			return [...ledger.values()].sort((a, b) => a.name.localeCompare(b.name));
		},
		async upsertInstalledPackages(rows: readonly SandboxPackageRow[]): Promise<void> {
			for (const row of rows) ledger.set(row.name, row);
		},
		async deleteInstalledPackage(name: string): Promise<void> {
			ledger.delete(name);
		},
		async contentHashAt(path: string): Promise<Uint8Array | undefined> {
			try {
				const bytes = await fs.readFileBuffer(path);
				return new Uint8Array(createHash("sha256").update(bytes).digest());
			} catch {
				return undefined;
			}
		},
	};

	Object.assign(fs, store, { state, ledger, graftedPaths });
	return fs as unknown as FakePackageFs;
}
