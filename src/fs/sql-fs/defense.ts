/**
 * Defense-in-depth helpers for routing Postgres I/O safely when just-bash's
 * `defenseInDepth` layer is active.
 *
 * just-bash monkey-patches dangerous globals during `bash.exec`. SqlFs runs in
 * the same event loop as the interpreter, so its DB driver calls happen inside
 * that patched scope. `DefenseInDepthBox.runTrustedAsync` exits the patched
 * scope for the duration of the callback (a no-op when no box is installed).
 *
 * just-bash 3.x additionally hardens `Error` by redefining `Error.stackTraceLimit`
 * as non-writable for the duration of the patched scope. The `postgres` driver
 * (porsager) temporarily assigns to `Error.stackTraceLimit` when it snapshots a
 * query's origin stack (`cachedError` in `postgres/src/query.js`), so in strict
 * mode that assignment throws `TypeError: Cannot assign to read only property
 * 'stackTraceLimit'` — breaking every query issued inside `bash.exec`.
 * `runTrustedAsync` does NOT fix this: the freeze is an `Error` property-descriptor
 * change, orthogonal to the trusted-scope guard. We re-open writability instead.
 */

import { DefenseInDepthBox } from "just-bash";

/**
 * Re-marks `Error.stackTraceLimit` writable when a defense-in-depth layer has
 * frozen it. just-bash leaves the property `configurable`, so we can redefine
 * it back to writable without changing its value.
 *
 * - No-op on just-bash < 3 (the property is never frozen there).
 * - No-op if the property is non-configurable (skip rather than throw).
 * - Idempotent: once writable, subsequent calls do nothing.
 *
 * Intentionally does NOT re-freeze afterwards. Re-freezing per call would race
 * across concurrent sessions sharing the process; instead we rely on the box's
 * own `restorePatches()` to restore the original (writable) descriptor when the
 * defense scope deactivates at the end of `bash.exec`.
 */
function ensureWritableStackTraceLimit(): void {
	const desc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
	if (desc?.writable === false && desc.configurable) {
		Object.defineProperty(Error, "stackTraceLimit", {
			value: desc.value,
			writable: true,
			configurable: true,
		});
	}
}

/**
 * Run trusted database I/O outside the defense-in-depth sandbox scope.
 *
 * Combines `DefenseInDepthBox.runTrustedAsync` (so the driver's timer/eval/etc.
 * usage is not flagged as a violation) with the `Error.stackTraceLimit` un-freeze
 * above. Every SqlFs DB chokepoint routes through this, so enabling
 * `JUST_BASH_DEFENSE_IN_DEPTH` cannot break Postgres on any just-bash version.
 */
export function runTrustedDbAsync<T>(fn: () => Promise<T>): Promise<T> {
	ensureWritableStackTraceLimit();
	return DefenseInDepthBox.runTrustedAsync(fn);
}
