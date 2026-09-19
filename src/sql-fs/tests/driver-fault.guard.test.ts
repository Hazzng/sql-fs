/**
 * Process-level behaviour of the #169 guard, driven as CHILD PROCESSES.
 *
 * None of this is expressible in-process: vitest registers its own `uncaughtException` and
 * `unhandledRejection` handlers before any test runs, so "the process would have died" is
 * unobservable from inside — a test asserting it passes with the guard removed. The exit code of a
 * real `node` process is the only honest signal.
 *
 * The `lookalike` and `unrelated` cases are NEGATIVE GUARDS: they assert the process still dies.
 * They are what stops the guard from degenerating into a blanket `uncaughtException` swallow, so a
 * change that widens the recogniser has to fail them.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/driver-fault.ts", import.meta.url));

interface ChildResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runFixture(mode: string): Promise<ChildResult> {
	try {
		const { stdout, stderr } = await run("npx", ["tsx", fixture, mode], {
			timeout: 60_000,
			// Short enough that the fixture's "stuck" await is declared stuck well inside the test
			// timeout; the production default is 5s.
			env: { ...process.env, PG_DRIVER_FAULT_GRACE_MS: "100" },
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

describe("driver fault guard (child process)", () => {
	it("survives the driver's socket-write fault and fails the stuck await", async () => {
		const { code, stdout } = await runFixture("absorb-uncaught");

		expect(stdout).toContain("SURVIVED EDRIVERFAULT");
		expect(code).toBe(0);
	}, 60_000);

	it("survives the same fault arriving as an unhandled rejection", async () => {
		const { code, stdout } = await runFixture("absorb-rejection");

		expect(stdout).toContain("SURVIVED rejection");
		expect(code).toBe(0);
	}, 60_000);

	// Boot shape: no server handle yet, so the startup race refs its grace timer to reach the verdict.
	it("holds a handle-less process open until the grace verdict when the startup race opts in", async () => {
		const { code, stdout } = await runFixture("startup-ref");

		expect(stdout).toContain("SURVIVED EDRIVERFAULT");
		expect(code).toBe(0);
	}, 60_000);

	// Pins the default the opt-in avoids: unref'd exits a handle-less process 0 pre-verdict.
	it("exits silently before the verdict when a handle-less race uses the default unref'd timer", async () => {
		const { code, stdout } = await runFixture("startup-unref");

		expect(stdout).not.toContain("SURVIVED");
		expect(code).toBe(0);
	}, 60_000);

	// NEGATIVE GUARD: same error class, same message, our stack. Must still kill the process.
	it("still dies on a look-alike TypeError thrown from our own code", async () => {
		const { code, stdout, stderr } = await runFixture("lookalike-uncaught");

		expect(stdout).not.toContain("MASKED");
		expect(stderr).toContain("Cannot read properties of null");
		expect(code).toBe(1);
	}, 60_000);

	// NEGATIVE GUARD: an ordinary bug keeps crash-and-restart.
	it("still dies on an unrelated uncaught exception", async () => {
		const { code, stdout, stderr } = await runFixture("unrelated-uncaught");

		expect(stdout).not.toContain("MASKED");
		expect(stderr).toContain("an ordinary bug");
		expect(code).toBe(1);
	}, 60_000);

	// NEGATIVE GUARD: installing an `unhandledRejection` listener must not turn Node's default
	// throw-on-unhandled-rejection into a warning.
	it("still dies on an unrelated unhandled rejection", async () => {
		const { code, stdout, stderr } = await runFixture("unrelated-rejection");

		expect(stdout).not.toContain("MASKED");
		expect(stderr).toContain("an ordinary rejection");
		expect(code).toBe(1);
	}, 60_000);
});
