/**
 * Tracks whether the current async stack already holds a Python runtime slot.
 *
 * `SessionManager.execWithRuntimeThrottle` takes a Python slot when the script
 * text matches `PYTHON_INVOCATION_REGEX`. The custom `python3` / `databricks`
 * commands also take a slot at the point they actually spawn the CPython WASM
 * worker, because `databricks foo` (and `pip install`, historically) spawn one
 * without the script text mentioning `python`.
 *
 * Both paths can be live at once for a script such as `python3 x.py`: the
 * outer regex matched, and the inner command is about to acquire again. This
 * AsyncLocalStorage flag, set by the throttle only inside the region where it
 * holds the slot, makes the inner acquire a no-op so one exec never occupies
 * two slots (which would deadlock at `MAX_CONCURRENT_PYTHON=1`).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface PythonSlotState {
	readonly held: true;
}

export const pythonSlotContext = new AsyncLocalStorage<PythonSlotState>();

/** True when an enclosing `execWithRuntimeThrottle` already holds a Python slot. */
export function pythonSlotAlreadyHeld(): boolean {
	return pythonSlotContext.getStore()?.held === true;
}
