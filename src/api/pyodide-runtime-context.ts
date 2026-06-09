/**
 * Per-exec attribution for the pyodide runtime's INTERNAL timeout.
 *
 * just-bash normalizes a custom-command handler rejection into a non-zero
 * `ExecResult` (the error lands in `stderr`, the exec RESOLVES) rather than
 * propagating it as a throw — only certain FS/builtin errors escape `bash.exec`
 * (see `withSessionReadEntry`'s `EREADONLY` remap). So when the manager's own
 * `PYODIDE_RUNTIME_TIMEOUT_MS` fires and `PyodideSandbox.run()` rejects with
 * {@link PyodideTimeoutError}, that typed error would otherwise be flattened into
 * a generic non-zero exit and the route would return 200 instead of a timeout.
 *
 * We bridge it the same way the read-only path bridges its violation: an
 * `AsyncLocalStorage` context that follows the async stack down into the pyodide
 * command. The command records the typed error on the context; `execWithRuntimeThrottle`
 * reads it back AFTER `bash.exec` resolves and re-throws it as a fatal error, so
 * the script transaction is ABORTED (a timed-out run never commits) and the route
 * layer maps `EPYODIDE_TIMEOUT` to a consistent timeout response.
 *
 * Per-exec (not per-session) because concurrent readOnly pyodide execs share one
 * session; a session-level flag would mis-attribute a timeout across readers.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface PyodideRuntimeContext {
	/** Set by the pyodide command when the manager's internal runtime timeout fired. */
	timeoutError?: Error;
}

export const pyodideRuntimeContext = new AsyncLocalStorage<PyodideRuntimeContext>();
