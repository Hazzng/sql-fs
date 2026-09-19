/**
 * Small helpers for reading numeric environment configuration safely.
 */

import { DEFAULT_CONTENT_CACHE_MAX_BYTES } from "../../sql-fs/sql-fs.js";

/**
 * Parse a positive-integer env var, falling back when the value is unset, empty,
 * non-numeric, or non-positive. A fractional value is floored.
 *
 * Required for any value used as a loop increment / batch size: a `0` would spin
 * the loop forever (it never advances) and a `NaN` would make the first
 * `slice(0, NaN)` empty so the loop silently processes nothing.
 *
 * @param value    Raw env value (`process.env.X`).
 * @param fallback Value returned when `value` is unset/invalid; must be > 0.
 */
export function positiveIntEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Largest single file body any write surface accepts (PUT, PATCH, MCP file_write).
 * One owner, so the HTTP and MCP limits cannot drift apart.
 *
 * Defaulted to the contentCache cap, not above it: a file the LRU accepts is retained once, while
 * one it rejects is retained twice over — and again per pool connection that read it, so load
 * testing measured a 64 MiB file costing 256 MB per warm session for the full `SESSION_IDLE_MS`.
 * Raising this past `DEFAULT_CONTENT_CACHE_MAX_BYTES` buys larger writes at 4x the memory each.
 *
 * Sizing note: on Linux a write costs roughly 7x the file size over baseline, and the bytes live
 * in `external`, not the V8 heap — so `--max-old-space-size` does not bound it and the cgroup
 * OOM-kills instead. At this default a single legal write needs a container of 768 MiB; 512 MiB
 * dies on one request.
 */
export const MAX_FILE_WRITE_BYTES = positiveIntEnv(process.env.MAX_FILE_WRITE_BYTES, DEFAULT_CONTENT_CACHE_MAX_BYTES);

// An override above the cache cap is allowed — a large container may legitimately want bigger
// files — but it must not be silent, because the cost is a step change rather than a gradient.
if (MAX_FILE_WRITE_BYTES > DEFAULT_CONTENT_CACHE_MAX_BYTES) {
	console.warn(
		JSON.stringify({
			event: "write_cap_above_content_cache",
			maxFileWriteBytes: MAX_FILE_WRITE_BYTES,
			contentCacheMaxBytes: DEFAULT_CONTENT_CACHE_MAX_BYTES,
			warning:
				"files above the contentCache cap are retained about twice over, and again per pool connection that reads one, for the whole SESSION_IDLE_MS",
		}),
	);
}

/**
 * Largest total decoded byte count one `POST /writeFiles` batch may carry.
 *
 * #168: this defaulted to 128 MiB against a 50 MiB per-file cap, so the bulk route was a 2.5x
 * wider door than the single-file route it batches — a 120 MiB bulk write blocked the event loop
 * for 669 ms, stalling every other tenant on the replica. Defaulting it to
 * {@link MAX_FILE_WRITE_BYTES} makes the batch cost no more synchronous work than the widest
 * single write the service already accepts, and ties the two together so they cannot drift.
 */
export const MAX_BULK_WRITE_BYTES = positiveIntEnv(process.env.MAX_BULK_WRITE_BYTES, MAX_FILE_WRITE_BYTES);

/**
 * Wire-size ceiling for the `POST /writeFiles` request body, counted off the stream before the
 * JSON parse (#168 — the route previously had no body cap at all, so only the 256 MiB global
 * backstop bounded what was parsed into memory).
 *
 * Twice {@link MAX_BULK_WRITE_BYTES}, not equal to it: the caps above are on *decoded* bytes,
 * while JSON string escaping roughly doubles the wire size of newline- or quote-heavy text. This
 * is a backstop on the parse, not a second content cap — the decoded totals are what the route
 * actually enforces.
 */
export const MAX_BULK_WRITE_BODY_BYTES = MAX_BULK_WRITE_BYTES * 2;

/**
 * Max number of entries in one batch write.
 *
 * Shared by `POST /writeFiles` and the optional `files` map on `POST /v1/sandboxes` (#168 M10):
 * both buffer every entry and write them in one synchronous run, so one owner keeps them from
 * drifting. Parsed with {@link positiveIntEnv} so a typo cannot turn the cap into `NaN`, which
 * would make every comparison false and remove it.
 */
export const MAX_BULK_WRITE_FILES = positiveIntEnv(process.env.MAX_BULK_WRITE_FILES, 1000);

/**
 * Largest file a sandbox `exec` script may read whole, or produce with one write (#168).
 *
 * Distinct from {@link MAX_FILE_WRITE_BYTES}, which bounds a single HTTP/MCP write body: that
 * path measured 158–254 ms at its 50 MiB cap, because it moves bytes. A bash script does not move
 * bytes, it rebuilds strings — `sed s///g` blocked the event loop 85 ms at 1 MiB, 706 ms at 8 MiB
 * and 2238 ms at 16 MiB, and 62.8% of that is GC from allocation pressure rather than CPU work,
 * so neither yielding nor a faster loop helps. The curve turns superlinear after 8 MiB.
 *
 * 8 MiB is chosen off the 2 s wall, not off the convenience of a round number: `src/redis/client.ts`
 * sets `commandTimeout: 2000`, so a stall longer than that times out in-flight Redis commands
 * belonging to *other* tenants — a cross-tenant correctness bug, not a latency blip. At 8 MiB a
 * single in-cap file leaves ~2.8x headroom under that wall; at 16 MiB one file is already through
 * it.
 *
 * PER FILE ONLY — the wall is NOT held for a script (#168 M12). Verified against the installed
 * just-bash:
 *  - `cat /a.txt /b.txt | wc -c` with two 8 MiB files is two independent in-cap checks and 16 MiB
 *    of pipeline work.
 *  - `sed 's/x/xxxxxxxx/g' 8mib.txt | wc -c` builds ~64 MiB of strings off ONE in-cap input; the
 *    4x in-memory expansion is unchecked, and with no redirect there is no write check either.
 * The boundary that would catch those is inside just-bash's pipeline, which this repo consumes as
 * a dependency and does not modify; a cumulative per-exec budget was considered and rejected as
 * worse (it fails a build touching 100 x 200 KB files that never stalls at all). #198 is the
 * structural fix — moving `bash.exec` off the main thread — which removes the wall rather than
 * rationing against it.
 *
 * So this is a stopgap that removes a capability — a script can no longer read or produce a single
 * file above the cap — and bounds the common single-file case, not the worst case. Raise it only
 * where the replica is not shared, or is not backed by Redis.
 */
export const MAX_EXEC_FILE_BYTES = positiveIntEnv(process.env.MAX_EXEC_FILE_BYTES, 8 * 1024 * 1024);
