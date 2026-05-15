/**
 * Custom `node` command — replaces just-bash's built-in nodeStubCommand.
 *
 * The built-in stub ignores all arguments and always prints the full js-exec
 * help page (60+ lines) before exiting 1.  This trips up agents that reach for
 * `node -e …` / `node script.js` and CI scripts that rely on exit 127 for
 * "command not found" semantics.
 *
 * This replacement:
 *   - `node --help`             → concise hint, exit 0
 *   - `node` (bare)             → same concise hint, exit 127
 *   - `node -e CODE [args…]`    → delegates to `js-exec -c CODE [args…]`
 *   - `node FILE [args…]`       → delegates to `js-exec FILE [args…]`
 *   - `node --version`          → reports the js-exec QuickJS version, exit 0
 *   - any other flag            → "unrecognized option" hint, exit 127
 *
 * Delegation via ctx.exec means the real js-exec command handles all of its
 * own flag parsing, runtime throttling, and error reporting — we never
 * duplicate that logic here.
 *
 * Fixes: https://github.com/Hazzng/virtualFS/issues/76
 */

import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";

const HINT = `\
'node' is not available in this sandbox. Use 'js-exec' instead:
  js-exec -c 'CODE'             # inline code  (replaces: node -e 'CODE')
  js-exec FILE.js               # run a file   (replaces: node FILE.js)
  js-exec --strip-types FILE.ts # TypeScript with type stripping
Run 'js-exec --help' for full options.
`;

function hintResult(exitCode: number): ExecResult {
	return { stdout: "", stderr: HINT, exitCode };
}

/**
 * Shell-quote a single token so it is safe to embed in a `js-exec …` command
 * string.  We use single-quote wrapping and escape any literal single quotes
 * inside the value (the classic `'...' → '\''...'\''` technique).
 */
function shellQuote(token: string): string {
	return `'${token.replace(/'/g, "'\\''")}'`;
}

export const nodeCommand = defineCommand("node", async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
	// Bare invocation — no arguments.
	if (args.length === 0) {
		return hintResult(127);
	}

	// args.length === 0 guard above ensures args[0] is present; the non-null
	// assertion is required because noUncheckedIndexedAccess types it as
	// `string | undefined` even after the length check.
	const first = args[0]!;

	// --help / -h — print the hint with a success exit so callers can detect
	// that the command exists and the user explicitly asked for help.
	if (first === "--help" || first === "-h") {
		return hintResult(0);
	}

	// --version / -v — forward to js-exec so the version string is consistent.
	if (first === "--version" || first === "-v") {
		if (ctx.exec !== undefined) {
			return ctx.exec("js-exec --version", { cwd: ctx.cwd });
		}
		// Fallback: cannot delegate, emit a hint.
		return hintResult(127);
	}

	// -e CODE [args…]  →  js-exec -c CODE [args…]
	if (first === "-e") {
		if (args.length < 2) {
			return {
				stdout: "",
				stderr: "node: -e requires an argument\nUse: js-exec -c 'CODE'\n",
				exitCode: 127,
			};
		}

		if (ctx.exec !== undefined) {
			// Build: js-exec -c CODE [extra-args…]
			// args.length >= 2 is guaranteed by the `args.length < 2` guard above.
			const code = args[1]!;
			const extraArgs = args.slice(2);
			const cmd = ["js-exec", "-c", shellQuote(code), ...extraArgs.map(shellQuote)].join(" ");
			return ctx.exec(cmd, { cwd: ctx.cwd });
		}
		return hintResult(127);
	}

	// Any other flag (starts with '-') that we don't recognise.
	if (first.startsWith("-")) {
		return {
			stdout: "",
			stderr: `node: unrecognized option '${first}'\n${HINT}`,
			exitCode: 127,
		};
	}

	// FILE [args…]  →  js-exec FILE [args…]
	if (ctx.exec !== undefined) {
		const cmd = ["js-exec", ...args.map(shellQuote)].join(" ");
		return ctx.exec(cmd, { cwd: ctx.cwd });
	}

	// ctx.exec is undefined (e.g., during unit tests without a full shell context).
	return hintResult(127);
});
