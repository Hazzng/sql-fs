import { createHash } from "node:crypto";
import { Bash, defineCommand, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");

describe("installed just-bash text backport", () => {
	it.each([31, 32, 33, 32767, 32768, 32769, 1048481])(
		"preserves transforms across builder boundary %i",
		async (size) => {
			const input = "aaabbbccc\n".repeat(Math.ceil(size / 10)).slice(0, size);
			const fs = new InMemoryFs({ "/input": input });
			const bash = new Bash({ fs, defenseInDepth: false });
			const transforms: Array<[string, string]> = [
				["tr a-z A-Z", input.toUpperCase()],
				["tr -d b", input.replaceAll("b", "")],
				["tr -s abc", input.replace(/([abc])\1+/g, "$1")],
				["sed 's/aaa/xyz/g'", input.replaceAll("aaa", "xyz")],
			];
			for (const [command, expected] of transforms) {
				const result = await bash.exec(`${command} < /input > /output`);
				expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
				const output = await fs.readFile("/output");
				expect(Buffer.byteLength(output)).toBe(Buffer.byteLength(expected));
				expect(hash(output)).toBe(hash(expected));
			}
		},
	);

	it.each([
		["export PROJECT_VAR=outer; sh -c 'printf %s \"$PROJECT_VAR\"'", "outer"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expands this literal.
		["UNEXPORTED=secret; sh -c 'printf %s \"${UNEXPORTED-unset}\"'", "unset"],
		["sh -c 'printf %s \"$HOST_FLAG\"'", "session"],
	])("retains nested shell environment behavior for %s", async (script, stdout) => {
		const result = await new Bash({ defenseInDepth: false }).exec(script, { env: { HOST_FLAG: "session" } });
		expect(result).toMatchObject({ exitCode: 0, stdout, stderr: "" });
	});

	it.each([
		["ENOENT", "No such file or directory"],
		["ENOTDIR", "Not a directory"],
	])("retains redirect diagnostics for %s", async (code, diagnostic) => {
		const fs = new InMemoryFs();
		fs.writeFile = async () => {
			throw Object.assign(new Error("rejected write"), { code });
		};
		const result = await new Bash({ fs, cwd: "/", defenseInDepth: false }).exec("echo content > /target/output");
		expect(result).toMatchObject({
			exitCode: 1,
			stdout: "",
			stderr: `bash: /target/output: ${diagnostic}\n`,
		});
	});
});

function executionGate() {
	let resolve!: () => void;
	return {
		promise: new Promise<void>((ready) => {
			resolve = ready;
		}),
		resolve: () => resolve(),
	};
}

describe("request cancellation provenance", () => {
	it("preserves a committed explicit exit 124 without an abort marker", async () => {
		const fs = new InMemoryFs();
		const controller = new AbortController();
		const result = await new Bash({ fs, defenseInDepth: false }).exec(
			"echo committed > /proof; echo 'bash: execution aborted' >&2; exit 124",
			{ signal: controller.signal },
		);

		expect(result.exitCode).toBe(124);
		expect(result.stderr).toBe("bash: execution aborted\n");
		expect(Object.hasOwn(result, "executionAborted")).toBe(false);
		expect(await fs.readFile("/proof")).toBe("committed\n");
	});

	it("does not trust a command-provided abort marker", async () => {
		const bash = new Bash({
			defenseInDepth: false,
			customCommands: [
				defineCommand("spoof", async () => ({
					stdout: "completed\n",
					stderr: "",
					exitCode: 124,
					executionAborted: true,
				})),
			],
		});
		const result = await bash.exec("spoof");

		expect(result.exitCode).toBe(124);
		expect(result.stdout).toBe("completed\n");
		expect(Object.hasOwn(result, "executionAborted")).toBe(false);
	});

	it.each([
		["echo committed > /proof; exit 124", 124, ""],
		["timeout 0.001 sleep 1; echo recovered; exit 0", 0, "recovered\n"],
	])("does not mark a completed execution when cleanup observes a late abort: %s", async (script, exitCode, stdout) => {
		const cleanupStarted = executionGate();
		const releaseCleanup = executionGate();
		const controller = new AbortController();
		const fs = new InMemoryFs();
		const bash = new Bash({
			fs,
			defenseInDepth: false,
			executionLimits: { maxExtensionCleanupTimeMs: 1_000 },
			customCommands: [
				defineCommand("hold-cleanup", async (_args, ctx) => {
					ctx.executionScope?.registerCleanup(async () => {
						cleanupStarted.resolve();
						await releaseCleanup.promise;
					});
					return { stdout: "", stderr: "", exitCode: 0 };
				}),
			],
		});
		const execution = bash.exec(`hold-cleanup; ${script}`, {
			signal: controller.signal,
		});

		await cleanupStarted.promise;
		controller.abort();
		releaseCleanup.resolve();
		const result = await execution;

		expect(result).toMatchObject({ exitCode, stdout, stderr: "" });
		expect(Object.hasOwn(result, "executionAborted")).toBe(false);
		if (exitCode === 124) {
			expect(await fs.readFile("/proof")).toBe("committed\n");
		}
		expect(await bash.exec("echo healthy")).toMatchObject({
			exitCode: 0,
			stdout: "healthy\n",
		});
	});

	it("does not mark a command-local timeout as request cancellation", async () => {
		const controller = new AbortController();
		const result = await new Bash({ defenseInDepth: false }).exec("timeout 0.001 sleep 1", {
			signal: controller.signal,
		});

		expect(result.exitCode).toBe(124);
		expect(controller.signal.aborted).toBe(false);
		expect(Object.hasOwn(result, "executionAborted")).toBe(false);
	});

	it.each([
		"sleep 60",
		"bash -c 'sleep 60'",
		"eval 'sleep 60'",
		"source /run.sh",
		'printf %s "$(sleep 60)"',
		"while true; do sleep 60; done",
	])("marks request cancellation observed in %s", async (script) => {
		const entered = executionGate();
		const controller = new AbortController();
		const bash = new Bash({
			fs: new InMemoryFs({ "/run.sh": "sleep 60" }),
			defenseInDepth: false,
			sleep: () => {
				entered.resolve();
				return new Promise<void>(() => {});
			},
			executionLimits: {
				maxExecutionTimeMs: 1_000,
				maxExtensionCleanupTimeMs: 5,
			},
		});
		const execution = bash.exec(script, { signal: controller.signal });
		await entered.promise;
		controller.abort();
		const result = await execution;

		expect(result.exitCode).toBe(124);
		expect(result).toHaveProperty("executionAborted", true);
		expect(Object.getOwnPropertyDescriptor(result, "executionAborted")).toMatchObject({
			enumerable: true,
		});
		expect(JSON.parse(JSON.stringify(result))).toHaveProperty("executionAborted", true);
		const next = await bash.exec("echo healthy");
		expect(next).toMatchObject({ exitCode: 0, stdout: "healthy\n", stderr: "" });
		expect(Object.hasOwn(next, "executionAborted")).toBe(false);
	});

	it("marks request cancellation before interpreter execution starts", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await new Bash({ defenseInDepth: false }).exec("echo unreachable", {
			signal: controller.signal,
		});

		expect(result).toMatchObject({ exitCode: 124, stdout: "", executionAborted: true });
	});

	it("marks cancellation observed while executing a loop", async () => {
		const controller = new AbortController();
		const bash = new Bash({
			defenseInDepth: false,
			customCommands: [
				defineCommand("abort-loop", async () => {
					controller.abort();
					return { stdout: "", stderr: "", exitCode: 0 };
				}),
			],
		});
		const result = await bash.exec("while true; do abort-loop; done", {
			signal: controller.signal,
		});
		expect(result).toMatchObject({ exitCode: 124, executionAborted: true });
	});
});
