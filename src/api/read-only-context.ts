/**
 * Per-call attribution for read-only scope violations.
 *
 * The parallel-readOnly bash exec path lets multiple readers run concurrently
 * against a single shared SqlFs. A boolean violation flag on the FS would be
 * shared across readers — a lying script in one reader would falsely flag
 * every concurrent innocent reader. We use AsyncLocalStorage so each
 * `withSessionRead` call gets its own context that follows its async stack
 * down into bash.exec / SqlFs writes; SqlFs marks the *calling* context on
 * EREADONLY rather than a shared flag.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ReadOnlyContext {
	violated: boolean;
}

export const readOnlyContext = new AsyncLocalStorage<ReadOnlyContext>();
