/**
 * Child-process fixtures for `driver-fault.guard.test.ts` (#169).
 *
 * Run as a CHILD on purpose. The failure under test is the process dying, and vitest installs its
 * own `uncaughtException` / `unhandledRejection` handlers, so an in-process assertion passes
 * whether or not the guard exists — exactly the trap that let an earlier crash test in this repo
 * pass with its fix removed.
 *
 * Mode is argv[2]. Each mode prints a single verdict line and lets the exit code carry the rest.
 */

import { installDriverFaultGuard, raceDriverFault } from "../../driver-fault.js";

/**
 * Verbatim from a live crash of the FAULT load-test replica
 * (`scripts/loadtest/.run/fault.log`) after
 * `ALTER DATABASE lt_fault SET idle_in_transaction_session_timeout = '1500ms'`.
 * The handler only ever sees the Error object, and the recogniser only reads `.stack`, so replaying
 * the real stack on a real TypeError is the same input the real fault delivers.
 */
const REAL_STACK = [
	"TypeError: Cannot read properties of null (reading 'write')",
	"    at Immediate.nextWrite (file:///app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:255:22)",
	"    at process.processImmediate (node:internal/timers:505:21)",
	"    at process.callbackTrampoline (node:internal/async_hooks:130:17)",
].join("\n");

function driverFault(): TypeError {
	const err = new TypeError("Cannot read properties of null (reading 'write')");
	err.stack = REAL_STACK;
	return err;
}

/** Same error class, same message, OUR stack. Must NOT be absorbed. */
function lookalike(): TypeError {
	const err = new TypeError("Cannot read properties of null (reading 'write')");
	err.stack = [
		"TypeError: Cannot read properties of null (reading 'write')",
		"    at writeChunk (file:///app/dist/sql-fs/sql-fs.js:1234:18)",
		"    at process.processImmediate (node:internal/timers:505:21)",
	].join("\n");
	return err;
}

const mode = process.argv[2];

installDriverFaultGuard();

if (mode === "absorb-uncaught") {
	// The in-flight DB await that the driver will never settle. If the guard only suppressed the
	// crash, this would hang and the fixture would time out instead of printing.
	const hung = raceDriverFault(() => new Promise<never>(() => {}));
	// Stands in for the HTTP server handle: the grace timer is unref'd so a fault can never hold a
	// draining process open, which means something else has to keep this fixture's loop alive.
	const keepAlive = setInterval(() => {}, 1_000);
	setImmediate(() => {
		throw driverFault();
	});
	try {
		await hung;
		clearInterval(keepAlive);
		process.stdout.write("NO-REJECTION\n");
		process.exit(3);
	} catch (err) {
		clearInterval(keepAlive);
		process.stdout.write(`SURVIVED ${(err as Error & { code?: string }).code}\n`);
		process.exit(0);
	}
} else if (mode === "startup-ref" || mode === "startup-unref") {
	// Boot shape: floating promise like the server bootstrap, no keepalive. `startup-ref` holds
	// the loop on the grace timer; `startup-unref` pins the default, which exits 0 pre-verdict.
	const hung = raceDriverFault(
		() => new Promise<never>(() => {}),
		mode === "startup-ref" ? { refTimer: true } : undefined,
	);
	setImmediate(() => {
		throw driverFault();
	});
	void (async () => {
		try {
			await hung;
			process.stdout.write("NO-REJECTION\n");
			process.exit(3);
		} catch (err) {
			process.stdout.write(`SURVIVED ${(err as Error & { code?: string }).code}\n`);
			process.exit(0);
		}
	})();
} else if (mode === "absorb-rejection") {
	void Promise.reject(driverFault());
	await new Promise((r) => setTimeout(r, 200));
	process.stdout.write("SURVIVED rejection\n");
	process.exit(0);
} else if (mode === "lookalike-uncaught") {
	setImmediate(() => {
		throw lookalike();
	});
	await new Promise((r) => setTimeout(r, 500));
	process.stdout.write("MASKED\n");
	process.exit(0);
} else if (mode === "unrelated-uncaught") {
	setImmediate(() => {
		throw new Error("an ordinary bug");
	});
	await new Promise((r) => setTimeout(r, 500));
	process.stdout.write("MASKED\n");
	process.exit(0);
} else if (mode === "unrelated-rejection") {
	void Promise.reject(new Error("an ordinary rejection"));
	await new Promise((r) => setTimeout(r, 500));
	process.stdout.write("MASKED\n");
	process.exit(0);
} else {
	process.stderr.write(`unknown mode: ${mode}\n`);
	process.exit(2);
}
