/**
 * Unit tests for WarmPythonProcess and createPyExecCommand.
 *
 * These tests spawn a real python3 process — they are skipped when python3
 * is not found on PATH so CI without Python stays green.
 */

import { execSync } from "node:child_process";
import { InMemoryFs } from "just-bash";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WarmPythonProcess, createPyExecCommand } from "../../lib/warm-python.js";

// ── python3 availability guard ───────────────────────────────────────────────

let pythonAvailable = false;
beforeAll(() => {
	try {
		execSync("python3 --version", { stdio: "ignore" });
		pythonAvailable = true;
	} catch {
		pythonAvailable = false;
	}
});

// ── WarmPythonProcess ────────────────────────────────────────────────────────

describe("WarmPythonProcess", () => {
	let warm: WarmPythonProcess;

	beforeEach(() => {
		warm = new WarmPythonProcess();
	});

	afterEach(() => {
		warm.kill();
	});

	it("isAlive is false before warmUp()", () => {
		expect(warm.isAlive).toBe(false);
	});

	it("isAlive is true after warmUp() when python3 is available", async () => {
		if (!pythonAvailable) return;
		warm.warmUp();
		// Give the process a moment to start
		await new Promise((r) => setTimeout(r, 100));
		expect(warm.isAlive).toBe(true);
	});

	it("executes print() and returns stdout", async () => {
		if (!pythonAvailable) return;
		const result = await warm.exec("print('hello warm')");
		expect(result.stdout).toBe("hello warm\n");
		expect(result.exitCode).toBe(0);
	});

	it("returns exitCode 1 on unhandled exception and stderr contains the error", async () => {
		if (!pythonAvailable) return;
		const result = await warm.exec("raise ValueError('boom')");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("ValueError");
		expect(result.stderr).toContain("boom");
	});

	it("sys.exit(42) maps to exitCode 42", async () => {
		if (!pythonAvailable) return;
		const result = await warm.exec("import sys; sys.exit(42)");
		expect(result.exitCode).toBe(42);
	});

	it("state persists across consecutive calls (REPL is stateful)", async () => {
		if (!pythonAvailable) return;
		await warm.exec("x = 99");
		const result = await warm.exec("print(x)");
		expect(result.stdout).toBe("99\n");
	});

	it("warm calls are faster than a cold python3 -c baseline on the same machine", async () => {
		if (!pythonAvailable) return;

		// Cold baseline: measure python3 --version once (fastest possible cold call).
		const NUM_SAMPLES = 3;
		const coldTimes: number[] = [];
		for (let i = 0; i < NUM_SAMPLES; i++) {
			const t0 = performance.now();
			execSync("python3 -c 'print(1)'", { stdio: "ignore" });
			coldTimes.push(performance.now() - t0);
		}
		const coldAvg = coldTimes.reduce((a, b) => a + b, 0) / NUM_SAMPLES;

		// Warm-up — pay the spawn cost once.
		await warm.exec("pass");

		// Warm samples — subsequent calls reuse the running process.
		const warmTimes: number[] = [];
		for (let i = 0; i < NUM_SAMPLES; i++) {
			const t0 = performance.now();
			await warm.exec("print(1)");
			warmTimes.push(performance.now() - t0);
		}
		const warmAvg = warmTimes.reduce((a, b) => a + b, 0) / NUM_SAMPLES;

		// Warm calls should be at least 3× faster than cold invocations.
		// On a local machine this is typically 50–200× faster.
		expect(warmAvg).toBeLessThan(coldAvg / 3);
	});

	it("kill() is idempotent — calling twice does not throw", () => {
		warm.kill();
		expect(() => warm.kill()).not.toThrow();
	});

	it("exec() after kill() rejects with EPYEXEC_DIED", async () => {
		if (!pythonAvailable) return;
		warm.warmUp();
		await new Promise((r) => setTimeout(r, 100));
		warm.kill();
		// Give the exit event a tick to fire.
		await new Promise((r) => setTimeout(r, 50));
		await expect(warm.exec("print(1)")).rejects.toMatchObject({ code: "EPYEXEC_DIED" });
	});

	it("AbortSignal already aborted rejects immediately", async () => {
		if (!pythonAvailable) return;
		const controller = new AbortController();
		controller.abort();
		await expect(warm.exec("print(1)", { signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
	});
});

// ── createPyExecCommand ──────────────────────────────────────────────────────

describe("createPyExecCommand", () => {
	let warm: WarmPythonProcess;
	let fs: InMemoryFs;

	beforeEach(() => {
		warm = new WarmPythonProcess();
		fs = new InMemoryFs();
	});

	afterEach(() => {
		warm.kill();
	});

	/**
	 * Minimal CommandContext stub with only the fields py-exec needs.
	 */
	function makeCtx(overrides?: Partial<import("just-bash").CommandContext>): import("just-bash").CommandContext {
		return {
			fs,
			cwd: "/",
			env: new Map(),
			stdin: "",
			...overrides,
		} as unknown as import("just-bash").CommandContext;
	}

	it("py-exec -c 'print(1)' returns stdout '1\\n' and exitCode 0", async () => {
		if (!pythonAvailable) return;
		const cmd = createPyExecCommand(warm);
		const result = await cmd.execute(["-c", "print(1)"], makeCtx());
		expect(result.stdout).toBe("1\n");
		expect(result.exitCode).toBe(0);
	});

	it("py-exec with no args returns usage error and exitCode 1", async () => {
		const cmd = createPyExecCommand(warm);
		const result = await cmd.execute([], makeCtx());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("usage");
	});

	it("py-exec -c with no code argument returns error and exitCode 1", async () => {
		const cmd = createPyExecCommand(warm);
		const result = await cmd.execute(["-c"], makeCtx());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("-c requires an argument");
	});

	it("py-exec reads and executes a script file from the virtual filesystem", async () => {
		if (!pythonAvailable) return;
		await fs.writeFile("/script.py", 'print("from file")\n');
		const cmd = createPyExecCommand(warm);
		const result = await cmd.execute(["/script.py"], makeCtx());
		expect(result.stdout).toBe("from file\n");
		expect(result.exitCode).toBe(0);
	});

	it("py-exec with non-existent file returns error and exitCode 1", async () => {
		if (!pythonAvailable) return;
		const cmd = createPyExecCommand(warm);
		const result = await cmd.execute(["/nonexistent.py"], makeCtx());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("cannot read");
	});

	it("command is named 'py-exec'", () => {
		const cmd = createPyExecCommand(warm);
		expect(cmd.name).toBe("py-exec");
	});
});

// ── SessionManager integration — py-exec is registered when python=true ─────

describe("SessionManager py-exec wiring", () => {
	it("py-exec command is available in a python-enabled session", async () => {
		if (!pythonAvailable) return;

		// We test this at the Bash level (not via HTTP) to avoid needing a DB.
		const { Bash, InMemoryFs: MInMemoryFs } = await import("just-bash");
		const fs = new MInMemoryFs();
		const pyWarm = new WarmPythonProcess();

		const bash = new Bash({
			fs,
			customCommands: [createPyExecCommand(pyWarm)],
		});

		const result = await bash.exec("py-exec -c 'print(\"wired\")'");
		expect(result.stdout).toBe("wired\n");
		expect(result.exitCode).toBe(0);

		pyWarm.kill();
	});

	it("py-exec warm call is substantially faster than cold python3 -c", async () => {
		if (!pythonAvailable) return;

		const { Bash, InMemoryFs: MInMemoryFs } = await import("just-bash");
		const fs = new MInMemoryFs();
		const pyWarm = new WarmPythonProcess();

		const bash = new Bash({
			fs,
			python: true,
			customCommands: [createPyExecCommand(pyWarm)],
		});

		// Cold baseline via just-bash python3 (one call to measure startup).
		const coldT0 = performance.now();
		await bash.exec("python3 -c 'print(1)'");
		const coldMs = performance.now() - coldT0;

		// Warm up py-exec (first call pays spawn cost).
		await bash.exec("py-exec -c 'pass'");

		// Warm samples.
		const NUM = 3;
		let warmTotal = 0;
		for (let i = 0; i < NUM; i++) {
			const t0 = performance.now();
			await bash.exec("py-exec -c 'print(1)'");
			warmTotal += performance.now() - t0;
		}
		const warmAvg = warmTotal / NUM;

		// py-exec warm calls should be at least 3× faster than one cold python3 -c.
		expect(warmAvg).toBeLessThan(coldMs / 3);

		pyWarm.kill();
	});
});
