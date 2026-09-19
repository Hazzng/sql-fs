/**
 * Per-call marker for "this filesystem call was issued by a bash script".
 *
 * #168: the exec-path file-size ceiling must bound only the reads and writes a
 * sandbox script makes, because those are the ones that feed just-bash's
 * synchronous text utilities. The HTTP/MCP file routes call the very same
 * `SqlFs` methods and already carry their own caps (`MAX_FILE_WRITE_BYTES`,
 * `MAX_MCP_READ_FILE_BYTES`, the `/writeFiles` body limits), so a flag on the
 * shared per-session `SqlFs` would be wrong twice over: it would tighten those
 * routes as a side effect, and — because parallel `readOnly` execs and a `GET`
 * can hold the shared session lock at the same time — it would leak one exec's
 * ceiling onto a concurrent download.
 *
 * AsyncLocalStorage instead, exactly as `readOnlyContext` does for read-only
 * scope violations: the store follows the async stack from `bash.exec` down
 * into the `IFileSystem` bridge, so only the script's own calls see it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecContext {
	/** Largest file this script may read whole or produce. See MAX_EXEC_FILE_BYTES. */
	readonly maxFileBytes: number;
	/**
	 * The first EFBIG this script tripped, recorded as well as thrown.
	 *
	 * Throwing alone is not enough on the read side: just-bash's text utilities catch every
	 * `IFileSystem` rejection and normalize it to `"<cmd>: <path>: No such file or directory"`
	 * on stderr with exit 1 — measured for `cat`, `wc`, `grep`, `head` and `<` redirection. So
	 * the message this cap exists to deliver would be replaced by a statement that is not just
	 * unhelpful but false: the file is right there. (A redirection *write* is the exception —
	 * that rejection escapes `bash.exec` intact.)
	 *
	 * `execWithRuntimeThrottle` therefore re-throws what is recorded here once the script
	 * returns, rolling the script-tx back first, exactly as `readOnlyContext.violated` turns a
	 * bash-normalized read-only violation back into `EREADONLY_VIOLATION`. First trip wins; the
	 * whole exec fails, which is deliberate fail-closed — a partially-applied script reported
	 * as a phantom ENOENT is the worse answer.
	 */
	exceeded?: Error;
}

export const execContext = new AsyncLocalStorage<ExecContext>();
