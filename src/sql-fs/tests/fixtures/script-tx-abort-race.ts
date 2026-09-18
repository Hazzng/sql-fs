/**
 * Fixture for `sql-fs.script-tx-abort-race.test.ts`, run as a CHILD process on purpose: the failure
 * under test is a process-killing unhandled rejection, and an in-process test cannot see it because
 * the test runner installs its own `unhandledRejection` handler first.
 *
 * Exits 0 when the abort is absorbed. Without the guard in `#openScriptTx`, Node's default
 * `--unhandled-rejections=throw` kills this with a non-zero exit and "script-tx aborted".
 */

import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const noop = async (): Promise<void> => {};

// Signals the moment the open is genuinely in flight, so the abort lands inside the window rather
// than before `#openScriptTx` has even been reached.
let reached!: () => void;
const opening = new Promise<void>((r) => {
	reached = r;
});

// Hangs where a connection pooler queues us: inside the transaction callback, before the only
// `await endPromise` is reached.
const dialect = {
	connect: noop,
	disconnect: noop,
	transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
	setSandboxContext: noop,
	setSandboxContextWithLock: () => {
		reached();
		return new Promise<void>(() => {});
	},
	loadAllPaths: async () => [
		{
			path: "/",
			inodeId: 1n,
			kind: 2,
			mode: 0o755,
			size: 0,
			mtime: new Date("2026-01-01T00:00:00Z"),
			contentSha256: null,
			symlinkTarget: null,
		} satisfies { path: string } & PathCacheEntry,
	],
	getBlobsForSandbox: async () => [],
	createSandbox: noop,
	deleteSandbox: noop,
	createInode: async () => 101n,
	getInode: noop,
	loadSubtreeInodes: async () => [],
	bulkIngest: noop,
	resolvePath: noop,
} as unknown as SqlDialect<unknown>;

const fs = new SqlFs({ dialect, sandboxId: "s-abort-race" });
await fs.ready();

fs.beginScriptScope();
// The write is expected to reject with the abort. Any OTHER rejection means the fixture stopped
// reaching the window under test — fail loudly rather than pass as a no-op.
void fs.writeFile("/x.txt", "y").catch((e: unknown) => {
	const message = (e as Error).message;
	if (!message.includes("script-tx aborted")) {
		process.stderr.write(`MISCONFIGURED: write failed before the abort window: ${message}\n`);
		process.exit(2);
	}
});
await opening;
await fs.abortScriptScope();
// Give Node a turn to report an unhandled rejection before we claim success.
await new Promise((r) => setTimeout(r, 50));
process.stdout.write("SURVIVED\n");
process.exit(0);
