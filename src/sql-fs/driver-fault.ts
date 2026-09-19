/**
 * Survives `postgres.js` throwing out of its own socket-write path (#169).
 *
 * When a backend is reaped mid-transaction (`idle_in_transaction_session_timeout`, a pooler
 * dropping a server connection), `connection.js` nulls its socket in `closed()` while a write for
 * that connection is still buffered. The buffered flush then runs as a bare `setImmediate`:
 *
 *     TypeError: Cannot read properties of null (reading 'write')
 *         at Immediate.nextWrite (…/postgres/src/connection.js:255:22)
 *         at process.processImmediate (node:internal/timers:505:21)
 *
 * There is no promise and no try/catch between that frame and the event loop, so it is a fatal
 * uncaught exception — one unlucky script kills the replica and every other in-flight request on
 * it. Measured 3/3 with the default `PG_POOL_MAX=2`. The same helper is reachable synchronously
 * from `execute`'s catch block (`connection.js:179` calls `write(Sync)` on the socket whose error
 * it is handling), which escapes as an unhandled rejection via `Query.handle`.
 *
 * Two halves, and both are needed:
 *
 * 1. `installDriverFaultGuard` keeps the process alive for exactly that frame. Anything else keeps
 *    Node's default behaviour, reproduced faithfully (see `fatal`) rather than approximated.
 * 2. `raceDriverFault` fails the in-flight request. The driver threw *instead of* rejecting the
 *    query it was writing, so that query's promise never settles: suppressing the crash on its own
 *    converts a loud replica death into a silent 120s hang with nothing committed. Every SqlFs
 *    await on the driver arms a grace window on a fault and fails with EDRIVERFAULT if it is still
 *    pending when that expires.
 */

import { createEdriverfault } from "./errors.js";

/**
 * The narrowing. `nextWrite` is the driver's private socket-flush helper; a stack frame naming it
 * inside `postgres/src/connection.js` cannot be produced by any other code in this process.
 *
 * Deliberately NOT matched on the message ("Cannot read properties of null" is V8-version specific)
 * nor on the line number (it moves between driver releases). The `Immediate.` prefix is optional so
 * the synchronous `execute` → `write(Sync)` path matches the same way.
 */
const DRIVER_WRITE_FRAME = /\bat (?:\S+\.)?nextWrite \([^)]*[/\\]postgres[/\\]src[/\\]connection\.js:/;

/**
 * True only for the driver's socket-write-during-error-handling fault.
 *
 * The `TypeError` requirement is the second half of the narrowing: it leaves a genuine
 * driver-raised `Error` surfacing through the same frame on the current crash-and-restart
 * behaviour rather than silently swallowing it.
 */
export function isDriverSocketFault(err: unknown): boolean {
	if (!(err instanceof TypeError)) return false;
	const { stack } = err;
	return typeof stack === "string" && DRIVER_WRITE_FRAME.test(stack);
}

type DriverFaultListener = (err: Error) => void;

const listeners = new Set<DriverFaultListener>();

/** Subscribe to recognised driver faults. Returns the unsubscribe. */
export function onDriverFault(listener: DriverFaultListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Wake every waiter. A listener that throws must not strand the rest — the process handler that
 * calls this is the last line of defence and has nowhere to report to.
 */
export function reportDriverFault(err: Error): void {
	for (const listener of [...listeners]) {
		try {
			listener(err);
		} catch {
			// A waiter that cannot be woken is not a reason to leave the others hanging.
		}
	}
}

/**
 * How long a DB await may stay pending after a fault before it is declared stuck.
 *
 * The fault handler cannot tell which connection the dropped write belonged to, so waking every
 * waiter immediately would fail healthy concurrent queries — and a query failed while it is still
 * on the wire may commit anyway, which is the applied-but-reported-failed shape this whole stack is
 * trying to remove. A grace window keeps the blast radius to awaits that are genuinely never going
 * to settle: a healthy statement finishes in milliseconds, a dropped one finishes never.
 */
const DEFAULT_GRACE_MS = 5_000;

let graceMs: number | undefined;

function faultGraceMs(): number {
	if (graceMs === undefined) {
		const raw = Number(process.env.PG_DRIVER_FAULT_GRACE_MS ?? DEFAULT_GRACE_MS);
		graceMs = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MS;
	}
	return graceMs;
}

/** Options for {@link raceDriverFault}. */
export interface RaceDriverFaultOptions {
	/**
	 * Keep the grace timer referenced until the verdict. Default false: a fault must never hold a
	 * serving process open. Opt in only before `serve()` listens, where no server/Redis handle
	 * exists yet and an unref'd timer lets the process exit 0 before the verdict.
	 */
	readonly refTimer?: boolean;
}

/**
 * Run a driver call, failing it if it is still pending a grace window after a driver fault.
 *
 * postgres.js throws out of its socket write INSTEAD of rejecting the query it was writing, and
 * nothing settles that query afterwards — not the connection's close handler (it already ran), not
 * the exec timeout's `AbortSignal` (the await is not abortable). This is the only thing that ends
 * such a wait, which is why suppressing the crash without it just buys a silent 120s hang.
 *
 * `Promise.race` subscribes to both arms, so whichever loses cannot resurface as an unhandled
 * rejection. The grace timer is `unref`'d by default: a fault must never hold the process open.
 */
export function raceDriverFault<T>(run: () => Promise<T>, options?: RaceDriverFaultOptions): Promise<T> {
	const pending = run();
	let unsubscribe!: () => void;
	let timer: NodeJS.Timeout | undefined;
	const fault = new Promise<never>((_resolve, reject) => {
		unsubscribe = onDriverFault((err) => {
			if (timer !== undefined) return;
			timer = setTimeout(() => reject(createEdriverfault(err)), faultGraceMs());
			if (options?.refTimer === true) timer.ref?.();
			else timer.unref?.();
		});
	});
	return Promise.race([pending, fault]).finally(() => {
		unsubscribe();
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * Restores Node's default for everything we do not recognise.
 *
 * Detaching first and re-throwing on the next tick reproduces the default path exactly — same
 * stderr dump, same exit code 1 — instead of approximating it with `console.error` + `exit()`,
 * which truncates on a piped stderr. An unhandled rejection under Node's default
 * `--unhandled-rejections=throw` mode is itself delivered as an uncaught exception carrying the
 * reason, so both arms converge here.
 */
function fatal(err: unknown, handlers: { uncaught: (e: unknown) => void; rejection: (r: unknown) => void }): void {
	process.removeListener("uncaughtException", handlers.uncaught);
	process.removeListener("unhandledRejection", handlers.rejection);
	process.nextTick(() => {
		throw err;
	});
}

let installed = false;

/**
 * Install the process-level guard. Idempotent; safe to call from any entry point.
 *
 * `PG_DRIVER_FAULT_GUARD=false` opts out and keeps the crash — see README for when that is the
 * right call.
 */
export function installDriverFaultGuard(): void {
	if (installed) return;
	if (process.env.PG_DRIVER_FAULT_GUARD === "false") return;
	installed = true;

	const handlers = {
		uncaught: (err: unknown): void => absorb(err, "uncaughtException"),
		rejection: (reason: unknown): void => absorb(reason, "unhandledRejection"),
	};

	function absorb(err: unknown, source: "uncaughtException" | "unhandledRejection"): void {
		if (!isDriverSocketFault(err)) {
			fatal(err, handlers);
			return;
		}
		const fault = err as Error;
		console.error(
			JSON.stringify({
				event: "driver_socket_fault",
				source,
				error: fault.message,
				stack: fault.stack,
				waiters: listeners.size,
			}),
		);
		reportDriverFault(fault);
	}

	process.on("uncaughtException", handlers.uncaught);
	process.on("unhandledRejection", handlers.rejection);
}
