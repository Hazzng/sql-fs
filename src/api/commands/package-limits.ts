/**
 * One place per package-install size limit, read from the environment once and
 * memoised; every message naming a number also names its knob.
 * `resetPackageLimits()` lets tests re-read a stubbed environment.
 */

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
} as const satisfies Record<keyof PackageLimits, string>;

const DEFAULTS: PackageLimits = {
	maxWheelBytes: 32 * 1024 * 1024,
	maxInstallDownloadBytes: 256 * 1024 * 1024,
	maxFileBytes: 32 * 1024 * 1024,
	maxInstallBytes: 512 * 1024 * 1024,
	maxInstallFiles: 50_000,
	sandboxQuotaBytes: 1024 * 1024 * 1024,
	sandboxMaxFiles: 100_000,
};

function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

let cached: PackageLimits | null = null;

/** Reads (once) and returns the process-wide package limits. */
export function packageLimits(): PackageLimits {
	if (cached === null) {
		cached = {
			maxWheelBytes: envPositiveInt(PACKAGE_LIMIT_ENV.maxWheelBytes, DEFAULTS.maxWheelBytes),
			maxInstallDownloadBytes: envPositiveInt(
				PACKAGE_LIMIT_ENV.maxInstallDownloadBytes,
				DEFAULTS.maxInstallDownloadBytes,
			),
			maxFileBytes: envPositiveInt(PACKAGE_LIMIT_ENV.maxFileBytes, DEFAULTS.maxFileBytes),
			maxInstallBytes: envPositiveInt(PACKAGE_LIMIT_ENV.maxInstallBytes, DEFAULTS.maxInstallBytes),
			maxInstallFiles: envPositiveInt(PACKAGE_LIMIT_ENV.maxInstallFiles, DEFAULTS.maxInstallFiles),
			sandboxQuotaBytes: envPositiveInt(PACKAGE_LIMIT_ENV.sandboxQuotaBytes, DEFAULTS.sandboxQuotaBytes),
			sandboxMaxFiles: envPositiveInt(PACKAGE_LIMIT_ENV.sandboxMaxFiles, DEFAULTS.sandboxMaxFiles),
		};
	}
	return cached;
}

/** Drops the memoised limits so the next `packageLimits()` re-reads the env. */
export function resetPackageLimits(): void {
	cached = null;
}
