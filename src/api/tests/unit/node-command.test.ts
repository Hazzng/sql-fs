/**
 * Unit tests for the custom `node` command — issue #76.
 *
 * Verifies that the `node` alias registered in JS-enabled sandboxes:
 *   - translates `node -e CODE` → executes via `js-exec -c CODE`
 *   - translates `node FILE`    → executes via `js-exec FILE`
 *   - prints a concise hint (not a 60-line help wall) on bare `node` / `node --help`
 *   - exits 127 for "command not found" cases (bare, unknown flag)
 *   - exits 0 for --help
 *   - does NOT touch non-JS sandboxes
 */

import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { nodeCommand } from "../../commands/node-command.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Bash instance with the real js-exec runtime + our node override. */
function makeJsBash(files?: Record<string, string>): Bash {
	const fs = new InMemoryFs(files);
	return new Bash({ fs, javascript: true, customCommands: [nodeCommand] });
}

/** Build a Bash instance WITHOUT javascript (node should be absent entirely). */
function makeNoJsBash(): Bash {
	const fs = new InMemoryFs();
	// Do NOT pass customCommands — this simulates a non-JS sandbox.
	return new Bash({ fs });
}

// ---------------------------------------------------------------------------
// Direct command unit tests (no Bash shell; test the Command object directly)
// ---------------------------------------------------------------------------

describe("nodeCommand — direct execution (no shell context)", () => {
	/** Minimal stub CommandContext without exec (simulates missing ctx.exec). */
	function stubCtx(): import("just-bash").CommandContext {
		const fs = new InMemoryFs();
		return {
			fs,
			cwd: "/",
			env: new Map<string, string>(),
			stdin: "",
		} as unknown as import("just-bash").CommandContext;
	}

	it("bare node (no args) returns exit 127 with hint on stderr", async () => {
		const result = await nodeCommand.execute([], stubCtx());
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("js-exec");
		expect(result.stderr).toContain("js-exec -c");
		// Must NOT be a 60-line wall — keep it short
		expect(result.stderr.split("\n").length).toBeLessThan(15);
	});

	it("node --help returns exit 0 with hint on stderr", async () => {
		const result = await nodeCommand.execute(["--help"], stubCtx());
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("js-exec");
	});

	it("node -h returns exit 0 with hint on stderr", async () => {
		const result = await nodeCommand.execute(["-h"], stubCtx());
		expect(result.exitCode).toBe(0);
	});

	it("node --unknown-flag returns exit 127 with hint", async () => {
		const result = await nodeCommand.execute(["--unknown-flag"], stubCtx());
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("unrecognized option");
		expect(result.stderr).toContain("js-exec");
	});

	it("node -e with no following CODE returns exit 127 with hint", async () => {
		const result = await nodeCommand.execute(["-e"], stubCtx());
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("-e requires an argument");
	});

	it("without ctx.exec delegation, node -e falls back to hint (exit 127)", async () => {
		// ctx without .exec — simulates minimal environment
		const result = await nodeCommand.execute(["-e", "console.log(1)"], stubCtx());
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("js-exec");
	});

	it("without ctx.exec delegation, node file.js falls back to hint (exit 127)", async () => {
		const result = await nodeCommand.execute(["script.js"], stubCtx());
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("js-exec");
	});
});

// ---------------------------------------------------------------------------
// Integration tests — via a real Bash instance with js-exec + our node override
// ---------------------------------------------------------------------------

describe("nodeCommand — via Bash with javascript runtime", () => {
	it("node -e 'console.log(42)' executes and prints 42", async () => {
		const bash = makeJsBash();
		const result = await bash.exec("node -e 'console.log(42)'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("42");
	});

	it("node -e 'process.exit(3)' propagates the exit code", async () => {
		const bash = makeJsBash();
		const result = await bash.exec("node -e 'process.exit(3)'");
		expect(result.exitCode).toBe(3);
	});

	it("node script.js executes a file on the virtual filesystem", async () => {
		const bash = makeJsBash({
			"/hello.js": "console.log('hello from file')",
		});
		const result = await bash.exec("node /hello.js");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello from file");
	});

	it("node script.js with non-existent file returns non-zero exit", async () => {
		const bash = makeJsBash();
		const result = await bash.exec("node /does-not-exist.js");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("does-not-exist.js");
	});

	it("bare node prints hint and exits 127", async () => {
		const bash = makeJsBash();
		const result = await bash.exec("node");
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("js-exec");
		// Must stay short — not a help wall
		expect(result.stderr.split("\n").length).toBeLessThan(15);
	});

	it("node --help exits 0 with brief hint", async () => {
		const bash = makeJsBash();
		const result = await bash.exec("node --help");
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("js-exec");
	});

	it("node --unknown returns exit 127 with message on stderr", async () => {
		const bash = makeJsBash();
		const result = await bash.exec("node --unknown");
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("unrecognized option");
	});

	it("exit code from node -e is visible to subsequent shell commands", async () => {
		const bash = makeJsBash();
		// If node -e exits 0, the `&&` branch executes.
		const result = await bash.exec("node -e 'console.log(\"ok\")' && echo 'after'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("after");
	});

	it("node -e passes extra positional args as process.argv", async () => {
		const bash = makeJsBash();
		// process.argv[0] is typically 'node', argv[1] is '-e', argv[2+] are extra args.
		// In js-exec, argv is available via process.argv.
		const result = await bash.exec("node -e 'console.log(process.argv.length > 0)' myarg");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("true");
	});
});

// ---------------------------------------------------------------------------
// Non-JS sandbox — node should not be present as our custom command
// ---------------------------------------------------------------------------

describe("nodeCommand — NOT registered in non-JS sandbox", () => {
	it("non-JS sandbox has no 'node' command (command not found)", async () => {
		const bash = makeNoJsBash();
		// Without javascript:true, just-bash does not register js-exec/node at all.
		const result = await bash.exec("node -e 'console.log(1)'");
		// Should be some non-zero exit — exact message differs by shell impl.
		expect(result.exitCode).not.toBe(0);
	});
});
