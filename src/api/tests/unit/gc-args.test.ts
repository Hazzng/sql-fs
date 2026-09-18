/**
 * Blob-GC CLI argument parsing (`src/api/cli/gc-args.ts`).
 *
 * The CLI entry point runs `main()` on import, so the parsing lives in its own
 * module and is tested here directly.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_BLOB_GC_MIN_AGE_MS,
	DEFAULT_MANIFEST_TTL_MS,
	parseGcArgs,
	resolveDurationMs,
} from "../../cli/gc-args.js";

/** Stand-in for `parseNonNegativeInt`, recording what the CLI asked the env for. */
function envReader(values: Readonly<Record<string, number>>): (name: string, fallback: number) => number {
	return (name, fallback) => values[name] ?? fallback;
}

describe("parseGcArgs", () => {
	it("returns all three values undefined for an empty argv", () => {
		expect(parseGcArgs([])).toEqual({ minAgeMs: undefined, manifestTtlMs: undefined, tenant: undefined });
	});

	it("parses --manifest-ttl-ms alongside --min-age-ms and --tenant", () => {
		expect(parseGcArgs(["--min-age-ms", "0", "--manifest-ttl-ms", "86400000", "--tenant", "t1"])).toEqual({
			minAgeMs: "0",
			manifestTtlMs: "86400000",
			tenant: "t1",
		});
	});

	it("parses --manifest-ttl-ms on its own", () => {
		expect(parseGcArgs(["--manifest-ttl-ms", "0"])).toEqual({
			minAgeMs: undefined,
			manifestTtlMs: "0",
			tenant: undefined,
		});
	});

	it("throws EINVAL when --manifest-ttl-ms has no value", () => {
		expect(() => parseGcArgs(["--manifest-ttl-ms"])).toThrowError("Missing value for --manifest-ttl-ms");
	});

	it("throws EINVAL when --manifest-ttl-ms is followed by another flag", () => {
		expect(() => parseGcArgs(["--manifest-ttl-ms", "--tenant", "t1"])).toThrowError(
			"Missing value for --manifest-ttl-ms",
		);
	});
});

describe("resolveDurationMs", () => {
	it("prefers the flag value over the env var", () => {
		const ms = resolveDurationMs(
			"--manifest-ttl-ms",
			"5",
			"PIP_MANIFEST_TTL_MS",
			DEFAULT_MANIFEST_TTL_MS,
			envReader({ PIP_MANIFEST_TTL_MS: 999 }),
		);
		expect(ms).toBe(5);
	});

	it("accepts 0 from the flag (collect every unreferenced manifest now)", () => {
		const ms = resolveDurationMs(
			"--manifest-ttl-ms",
			"0",
			"PIP_MANIFEST_TTL_MS",
			DEFAULT_MANIFEST_TTL_MS,
			envReader({ PIP_MANIFEST_TTL_MS: 999 }),
		);
		expect(ms).toBe(0);
	});

	it("reads the env var when the flag is absent", () => {
		const ms = resolveDurationMs(
			"--manifest-ttl-ms",
			undefined,
			"PIP_MANIFEST_TTL_MS",
			DEFAULT_MANIFEST_TTL_MS,
			envReader({ PIP_MANIFEST_TTL_MS: 123 }),
		);
		expect(ms).toBe(123);
	});

	it("falls back to 30 days for the manifest TTL when neither is set", () => {
		const ms = resolveDurationMs(
			"--manifest-ttl-ms",
			undefined,
			"PIP_MANIFEST_TTL_MS",
			DEFAULT_MANIFEST_TTL_MS,
			envReader({}),
		);
		expect(ms).toBe(2_592_000_000);
	});

	it("falls back to 3 hours for the blob grace window when neither is set", () => {
		const ms = resolveDurationMs(
			"--min-age-ms",
			undefined,
			"BLOB_GC_MIN_AGE_MS",
			DEFAULT_BLOB_GC_MIN_AGE_MS,
			envReader({}),
		);
		expect(ms).toBe(10_800_000);
	});

	it("throws EINVAL naming the flag for a negative value", () => {
		expect(() =>
			resolveDurationMs("--manifest-ttl-ms", "-1", "PIP_MANIFEST_TTL_MS", DEFAULT_MANIFEST_TTL_MS, envReader({})),
		).toThrowError('--manifest-ttl-ms must be a non-negative integer (got "-1").');
	});

	it("throws EINVAL naming the flag for a non-integer value", () => {
		expect(() =>
			resolveDurationMs("--min-age-ms", "1.5", "BLOB_GC_MIN_AGE_MS", DEFAULT_BLOB_GC_MIN_AGE_MS, envReader({})),
		).toThrowError('--min-age-ms must be a non-negative integer (got "1.5").');
	});
});
