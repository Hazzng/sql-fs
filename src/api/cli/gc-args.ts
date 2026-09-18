/**
 * Argument and duration parsing for the blob-GC CLI, split out of `gc.ts` so it
 * is unit-testable: importing `gc.ts` would run `main()`.
 */

/** Raw (unparsed) CLI arguments. */
export interface GcCliArgs {
	readonly minAgeMs: string | undefined;
	readonly manifestTtlMs: string | undefined;
	readonly tenant: string | undefined;
}

/** Default orphan-blob grace window: 3 hours. */
export const DEFAULT_BLOB_GC_MIN_AGE_MS = 3 * 60 * 60 * 1000;

/** Default package-manifest TTL: 30 days. */
export const DEFAULT_MANIFEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parses `--min-age-ms`, `--manifest-ttl-ms` and `--tenant`. Unknown arguments
 * are ignored (as before). Throws `code: "EINVAL"` when a flag is last on the
 * line or is followed by another flag.
 */
export function parseGcArgs(argv: readonly string[]): GcCliArgs {
	let minAgeMs: string | undefined;
	let manifestTtlMs: string | undefined;
	let tenant: string | undefined;

	const readValue = (flag: string, index: number): string => {
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) {
			throw Object.assign(new Error(`Missing value for ${flag}`), { code: "EINVAL" });
		}
		return next;
	};

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--min-age-ms") {
			minAgeMs = readValue("--min-age-ms", i);
			i++;
		} else if (argv[i] === "--manifest-ttl-ms") {
			manifestTtlMs = readValue("--manifest-ttl-ms", i);
			i++;
		} else if (argv[i] === "--tenant") {
			tenant = readValue("--tenant", i);
			i++;
		}
	}

	return { minAgeMs, manifestTtlMs, tenant };
}

/**
 * Resolves one duration: the flag value when given, else `readEnv(envVar)`,
 * else `fallback`. Throws `code: "EINVAL"` naming the flag when the flag value
 * is not a non-negative integer.
 */
export function resolveDurationMs(
	flag: string,
	value: string | undefined,
	envVar: string,
	fallback: number,
	readEnv: (name: string, fallback: number) => number,
): number {
	if (value === undefined) return readEnv(envVar, fallback);
	if (value.trim() === "") {
		throw Object.assign(new Error(`${flag} must be a non-negative integer (got "${value}").`), { code: "EINVAL" });
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw Object.assign(new Error(`${flag} must be a non-negative integer (got "${value}").`), { code: "EINVAL" });
	}
	return parsed;
}
