/**
 * An abort can land while the script-tx is still opening — an exec timing out while its first
 * statement sits in a pooler's queue. `#scriptTxAbort` is published before the only
 * `await endPromise` is reached, so without a guard that abort rejects a promise nobody is
 * listening to and Node's default `--unhandled-rejections=throw` kills the process. Direct to
 * Postgres the window is microseconds; behind PgBouncer it is as wide as `query_wait_timeout`,
 * which turned a latent bug into a crash loop.
 *
 * Driven as a child process because an in-process assertion cannot observe this: the test runner
 * registers its own `unhandledRejection` handler, so the rejection is absorbed and the test passes
 * whether or not the bug is present.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/script-tx-abort-race.ts", import.meta.url));

describe("script-tx abort while the transaction is still opening", () => {
	it("survives an abort that beats the open", async () => {
		const { stdout } = await run("npx", ["tsx", fixture], { timeout: 60_000 });

		expect(stdout).toContain("SURVIVED");
	}, 60_000);
});
