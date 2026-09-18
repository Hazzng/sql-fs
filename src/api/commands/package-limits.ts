/**
 * One place per package-install size limit, read from the environment once and
 * memoised; every message naming a number also names its knob.
 * `resetPackageLimits()` lets tests re-read a stubbed environment.
 */

import { positiveIntEnv } from "../lib/env.js";

export interface PackageLimits {
	/** Largest single wheel accepted from PyPI. */
	readonly maxWheelBytes: number;
	/** Cumulative downloaded bytes for one `pip install` invocation. */
	readonly maxInstallDownloadBytes: number;
	/** Largest single extracted file. */
	readonly maxFileBytes: number;
	/** Cumulative extracted bytes for one `pip install` invocation. */
	readonly maxInstallBytes: number;
	/** Cumulative extracted file count for one `pip install` invocation. */
	readonly maxInstallFiles: number;
	/** Total package bytes a single sandbox may hold. */
	readonly sandboxQuotaBytes: number;
	/** Total package files a single sandbox may hold. */
	readonly sandboxMaxFiles: number;
	/** Cap for a single PyPI JSON response. */
	readonly maxMetadataResponseBytes: number;
	/** Cumulative metadata bytes for one `pip install` invocation. */
	readonly maxTotalMetadataBytes: number;
	/** Cumulative metadata requests for one `pip install` invocation. */
	readonly maxMetadataRequests: number;
	/** Entries the resolver's per-install metadata cache may hold. */
	readonly maxMetadataCacheEntries: number;
	/** Longest dependency path the resolver will follow. */
	readonly maxDependencyDepth: number;
}

/** Env var name for each limit, used in error messages. */
export const PACKAGE_LIMIT_ENV = {
	maxWheelBytes: "PIP_MAX_WHEEL_BYTES",
	maxInstallDownloadBytes: "PIP_MAX_INSTALL_DOWNLOAD_BYTES",
	maxFileBytes: "PIP_MAX_FILE_BYTES",
	maxInstallBytes: "PIP_MAX_INSTALL_BYTES",
	maxInstallFiles: "PIP_MAX_INSTALL_FILES",
	sandboxQuotaBytes: "PIP_SANDBOX_QUOTA_BYTES",
	sandboxMaxFiles: "PIP_SANDBOX_MAX_FILES",
	maxMetadataResponseBytes: "PIP_MAX_METADATA_RESPONSE_BYTES",
	maxTotalMetadataBytes: "PIP_MAX_METADATA_BYTES",
	maxMetadataRequests: "PIP_MAX_METADATA_REQUESTS",
	maxMetadataCacheEntries: "PIP_MAX_METADATA_CACHE_ENTRIES",
	maxDependencyDepth: "PIP_MAX_DEPENDENCY_DEPTH",
} as const satisfies Record<keyof PackageLimits, string>;

const DEFAULTS: PackageLimits = {
	maxWheelBytes: 32 * 1024 * 1024,
	maxInstallDownloadBytes: 256 * 1024 * 1024,
	maxFileBytes: 32 * 1024 * 1024,
	maxInstallBytes: 512 * 1024 * 1024,
	maxInstallFiles: 50_000,
	sandboxQuotaBytes: 1024 * 1024 * 1024,
	sandboxMaxFiles: 100_000,
	maxMetadataResponseBytes: 16 * 1024 * 1024,
	maxTotalMetadataBytes: 32 * 1024 * 1024,
	maxMetadataRequests: 200,
	maxMetadataCacheEntries: 200,
	maxDependencyDepth: 16,
};

let cached: PackageLimits | null = null;

/** Reads (once) and returns the process-wide package limits. */
export function packageLimits(): PackageLimits {
	if (cached === null) {
		cached = Object.fromEntries(
			Object.entries(DEFAULTS).map(([key, fallback]) => [
				key,
				positiveIntEnv(process.env[PACKAGE_LIMIT_ENV[key as keyof PackageLimits]], fallback),
			]),
		) as unknown as PackageLimits;
	}
	return cached;
}

/** Drops the memoised limits so the next `packageLimits()` re-reads the env. */
export function resetPackageLimits(): void {
	cached = null;
}
