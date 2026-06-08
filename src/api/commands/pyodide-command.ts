/**
 * Custom `python3` / `python` commands backed by a per-session
 * {@link PyodideSandbox} (the OS-isolated Deno subprocess). Registered only when
 * a sandbox's `python_runtime` is `"pyodide"` (see `session-manager.ts`).
 *
 * Flow per invocation:
 *   1. Parse the `python3` surface (`-c CODE`, `FILE`, `-`/stdin, `--version`,
 *      `-m` → unsupported, bare → hint).
 *   2. Stage the **cwd subtree** (+ a resolved script file outside cwd) into the
 *      request's `files`, base64-encoding contents, under per-file/total caps.
 *   3. `sandbox.run(...)` — the manager serializes, validates frames, and THROWS
 *      on timeout/abort/integrity/child-exit (we let it propagate so `bash.exec`
 *      rejects → the script transaction rolls back and nothing drains).
 *   4. On a resolved response, **drain** `created`/`modified`/`deleted` into
 *      `ctx.fs` — cwd-scoped + path-validated + capped — inside the same script
 *      transaction, so the writes are atomic with the rest of the script.
 *
 * The response may be `type:"error"` (non-zero exit = a normal Python failure);
 * that still drains and returns `{stdout, stderr, exitCode}`. The drain gate is a
 * *resolved* run, not `exitCode === 0`.
 */

import { Buffer } from "node:buffer";
import {
	type CommandContext,
	type CustomCommand,
	type ExecResult,
	decodeBytesToUtf8,
	defineCommand,
	latin1FromBytes,
} from "just-bash";
import type { IFileSystem } from "just-bash";
import type { FsEntry, RunResponse } from "../../pyodide-runner/protocol.js";
import type { PyodideSandbox, RunRequestInput } from "../pyodide/manager.js";

/** Default per-file cap on staged-in / drained-out file bytes (32 MiB). */
export const PYODIDE_MAX_FILE_BYTES_DEFAULT = 32 * 1024 * 1024;
/** Default total cap across all staged-in / drained-out files (128 MiB). */
export const PYODIDE_MAX_TOTAL_BYTES_DEFAULT = 128 * 1024 * 1024;

// Pyodide 0.29.4 ships CPython 3.13 (Phase 3 Discoveries).
const VERSION_LINE = "Python 3.13.2 (Pyodide)\n";

const HINT = `\
'python3' here runs in the Pyodide runtime (numpy/pandas/scipy/openpyxl), OS-isolated and air-gapped.
  python3 script.py [args…]     # run a script file
  python3 -c 'CODE' [args…]     # run inline code
  echo 'CODE' | python3         # run code from stdin
  python3 --version             # report the runtime version
'-m MODULE' and an interactive REPL are not supported.
`;

// Never-aborting fallback when a CommandContext has no signal (defensive).
const NEVER_ABORT: AbortSignal = new AbortController().signal;

interface Caps {
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
}

export interface PyodideCommandOptions {
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
}

/** A drain / staging policy violation. Surfaces as a non-zero exec, rolling back the script tx. */
export class PyodideDrainError extends Error {
	readonly code = "EPYODIDE_DRAIN";
	constructor(message: string) {
		super(`EPYODIDE_DRAIN: ${message}`);
		this.name = "PyodideDrainError";
	}
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

function makeAbortError(): Error {
	return Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" });
}

function errResult(message: string, exitCode: number): ExecResult {
	return { stdout: "", stderr: `${message}\n`, exitCode };
}

/** byte length of the data a base64 string decodes to, without allocating it. */
function base64ByteLength(b64: string): number {
	if (b64.length === 0) return 0;
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * `sandbox` may be a {@link PyodideSandbox} (fixed, used by unit tests) or a
 * resolver `() => PyodideSandbox`. The SessionManager passes a resolver that reads
 * the LIVE `session.pyodideSandbox`, so a residency re-admit after eviction
 * (Phase 6) is picked up without rebuilding the command. The resolver is called
 * per invocation.
 */
export function createPyodideCommands(
	sandbox: PyodideSandbox | (() => PyodideSandbox),
	opts: PyodideCommandOptions = {},
): CustomCommand[] {
	const caps: Caps = {
		maxFileBytes: opts.maxFileBytes ?? envInt("PYODIDE_MAX_FILE_BYTES", PYODIDE_MAX_FILE_BYTES_DEFAULT),
		maxTotalBytes: opts.maxTotalBytes ?? envInt("PYODIDE_MAX_TOTAL_BYTES", PYODIDE_MAX_TOTAL_BYTES_DEFAULT),
	};
	const getSandbox = typeof sandbox === "function" ? sandbox : (): PyodideSandbox => sandbox;
	const handler = (args: string[], ctx: CommandContext): Promise<ExecResult> => runPython(getSandbox, caps, args, ctx);
	return [defineCommand("python3", handler), defineCommand("python", handler)];
}

interface Parsed {
	readonly code: string;
	readonly argv: string[];
	/** base64 of the program's own stdin ("" when stdin was consumed as the program). */
	readonly stdin: string;
	/** Absolute path of a FILE script resolved OUTSIDE cwd that must also be staged
	 *  (python3 FILE parity). Staged in `runPython` under the same caps as the cwd walk. */
	readonly scriptPathOutsideCwd?: string;
}

async function runPython(
	getSandbox: () => PyodideSandbox,
	caps: Caps,
	args: string[],
	ctx: CommandContext,
): Promise<ExecResult> {
	const first = args[0];

	// `--version` / `-h` / `-m` short-circuit WITHOUT resolving the sandbox, so the
	// metadata surface works even before a manager has been lazily admitted.
	if (first === "--version" || first === "-V") return { stdout: VERSION_LINE, stderr: "", exitCode: 0 };
	if (first === "-h" || first === "--help") return { stdout: "", stderr: HINT, exitCode: 0 };
	if (first === "-m") return errResult("python3: the -m option is not supported in the pyodide runtime", 2);

	const parsed = await parseProgram(args, ctx);
	if ("error" in parsed) return parsed.error;

	// Stage the cwd subtree (+ a script file outside cwd) into the request, under
	// per-file + total byte caps applied to BOTH sources from a shared budget.
	let files: FsEntry[];
	try {
		const staged = await stageCwd(ctx.fs, ctx.cwd, caps);
		files = staged.files;
		if (parsed.scriptPathOutsideCwd !== undefined) {
			const { entry } = await stageFile(ctx.fs, parsed.scriptPathOutsideCwd, caps, staged.total);
			files.push(entry);
		}
	} catch (err) {
		if (err instanceof PyodideDrainError) return errResult(err.message, 1);
		throw err;
	}

	const input: RunRequestInput = { code: parsed.code, argv: parsed.argv, stdin: parsed.stdin, files, cwd: ctx.cwd };

	// Resolve the sandbox only now (an actual run is required). Manager THROWS on
	// timeout/abort/integrity/child-exit — let it propagate so bash.exec rejects and
	// the script transaction rolls back (drains nothing).
	const resp = await getSandbox().run(input, ctx.signal ?? NEVER_ABORT);

	// Abort that landed after the response but before the drain → drain nothing.
	if (ctx.signal?.aborted) throw makeAbortError();

	await drain(ctx.fs, ctx.cwd, resp, caps);

	return {
		stdout: Buffer.from(resp.stdout, "base64").toString("utf8"),
		stderr: Buffer.from(resp.stderr, "base64").toString("utf8"),
		exitCode: resp.exitCode,
	};
}

async function parseProgram(args: string[], ctx: CommandContext): Promise<Parsed | { error: ExecResult }> {
	const first = args[0];

	if (first === "-c") {
		if (args.length < 2) return { error: errResult("python3: argument expected for the -c option", 2) };
		// argv[0]="-c"; the script's own args follow the CODE operand.
		return { code: args[1] as string, argv: ["-c", ...args.slice(2)], stdin: stdinBase64(ctx) };
	}

	if (first === "-" || first === undefined) {
		// `python3 -` (explicit) or bare `python3` reading a program piped on stdin.
		const program = decodeBytesToUtf8(ctx.stdin);
		if (first === undefined && program.length === 0) {
			// Bare invocation, no piped program → an interactive REPL we don't offer.
			return { error: { stdout: "", stderr: HINT, exitCode: 0 } };
		}
		const argv = first === "-" ? ["-", ...args.slice(1)] : [""];
		return { code: program, argv, stdin: "" };
	}

	if (first.startsWith("-")) return { error: errResult(`python3: unknown option ${first}`, 2) };

	// FILE [args…]
	if (first.includes("\0")) return { error: errResult("python3: invalid file path", 2) };
	const resolved = ctx.fs.resolvePath(ctx.cwd, first);
	let code: string;
	try {
		code = await ctx.fs.readFile(resolved, "utf8");
	} catch {
		return { error: errResult(`python3: can't open file '${first}': [Errno 2] No such file or directory`, 2) };
	}
	return {
		code,
		argv: [first, ...args.slice(1)],
		stdin: stdinBase64(ctx),
		scriptPathOutsideCwd: isUnderCwd(resolved, ctx.cwd) ? undefined : resolved,
	};
}

function stdinBase64(ctx: CommandContext): string {
	return Buffer.from(latin1FromBytes(ctx.stdin), "latin1").toString("base64");
}

function cwdPrefix(cwd: string): string {
	return cwd.endsWith("/") ? cwd : `${cwd}/`;
}

function isUnderCwd(path: string, cwd: string): boolean {
	return path === cwd || path.startsWith(cwdPrefix(cwd));
}

/** Enforce per-file + running-total staging caps. Throws on violation. */
function enforceStageCaps(size: number, path: string, caps: Caps, runningTotal: number): void {
	if (size > caps.maxFileBytes) {
		throw new PyodideDrainError(`'${path}' (${size} bytes) exceeds the per-file stage cap`);
	}
	if (runningTotal + size > caps.maxTotalBytes) {
		throw new PyodideDrainError("staged files exceed the total byte cap");
	}
}

/**
 * Stage a single regular file: refuse symlinks (default-deny), enforce the caps
 * against `runningTotal`, capture the real mode, and base64-encode the bytes.
 */
async function stageFile(
	fs: IFileSystem,
	path: string,
	caps: Caps,
	runningTotal: number,
): Promise<{ entry: FsEntry; size: number }> {
	const st = await fs.lstat(path);
	if (st.isSymbolicLink) throw new PyodideDrainError(`refusing to stage a symlink: ${path}`);
	const bytes = await fs.readFileBuffer(path);
	enforceStageCaps(bytes.byteLength, path, caps, runningTotal);
	return {
		entry: { path, kind: "file", mode: st.mode & 0o777, data: Buffer.from(bytes).toString("base64") },
		size: bytes.byteLength,
	};
}

/** Walk the cwd subtree (dirs + files), base64-encoding file bytes, under the caps. */
async function stageCwd(fs: IFileSystem, cwd: string, caps: Caps): Promise<{ files: FsEntry[]; total: number }> {
	const out: FsEntry[] = [];
	let total = 0;
	if (!(await fs.exists(cwd))) return { files: out, total };

	const walk = async (dir: string): Promise<void> => {
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (name === "." || name === "..") continue;
			const full = dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
			const st = await fs.lstat(full);
			if (st.isSymbolicLink) continue; // default-deny: never stage symlinks
			if (st.isDirectory) {
				out.push({ path: full, kind: "dir", mode: st.mode & 0o777, data: "" });
				await walk(full);
			} else if (st.isFile) {
				const { entry, size } = await stageFile(fs, full, caps, total);
				total += size;
				out.push(entry);
			}
		}
	};
	await walk(cwd);
	return { files: out, total };
}

/**
 * Drain the cwd-scoped diff into `ctx.fs`, inside the live script transaction.
 * Validates EVERY path stays under cwd (rejecting `..`, absolute-outside-cwd, and
 * null bytes) and enforces the byte caps BEFORE any write — so a forged/buggy
 * runner can never escape the cwd or blow the budget. Applies created
 * dirs-before-files (runner-ordered), then modified files, then deleted
 * depth-first (runner-ordered). Throws {@link PyodideDrainError} on a violation,
 * which rolls the transaction back.
 */
export async function drain(fs: IFileSystem, cwd: string, resp: RunResponse, caps: Caps): Promise<void> {
	const assertUnderCwd = (path: string, label: string): string => {
		if (path.includes("\0")) throw new PyodideDrainError(`${label} path contains a null byte`);
		const resolved = fs.resolvePath(cwd, path);
		if (!isUnderCwd(resolved, cwd)) throw new PyodideDrainError(`${label} path escapes cwd: ${path}`);
		return resolved;
	};

	// 1. Validate paths + caps for everything before writing anything.
	let total = 0;
	for (const e of [...resp.created, ...resp.modified]) {
		assertUnderCwd(e.path, "drain");
		if (e.kind === "file") {
			const n = base64ByteLength(e.data);
			if (n > caps.maxFileBytes) throw new PyodideDrainError(`'${e.path}' (${n} bytes) exceeds the per-file drain cap`);
			total += n;
		}
	}
	if (total > caps.maxTotalBytes) throw new PyodideDrainError("drained files exceed the total byte cap");
	for (const p of resp.deleted) assertUnderCwd(p, "deleted");

	// 2. Apply created (dirs shallow→deep, then files), then modified files.
	for (const e of resp.created) await applyEntry(fs, cwd, e);
	for (const e of resp.modified) await applyEntry(fs, cwd, e);

	// 3. Apply deletions depth-first (runner already orders deepest-first).
	for (const p of resp.deleted) {
		const resolved = fs.resolvePath(cwd, p);
		try {
			await fs.rm(resolved, { recursive: true, force: true });
		} catch {
			// already gone — idempotent
		}
	}
}

async function applyEntry(fs: IFileSystem, cwd: string, entry: FsEntry): Promise<void> {
	const resolved = fs.resolvePath(cwd, entry.path);

	// Default-deny: never write through / over an existing symlink at the target.
	if (await fs.exists(resolved)) {
		const st = await fs.lstat(resolved);
		if (st.isSymbolicLink) throw new PyodideDrainError(`refusing to drain over a symlink: ${entry.path}`);
	}

	if (entry.kind === "dir") {
		await fs.mkdir(resolved, { recursive: true });
		return;
	}

	const bytes = new Uint8Array(Buffer.from(entry.data, "base64"));
	await fs.writeFile(resolved, bytes);
	// writeFile creates with the default 0644; only chmod when the runner reported
	// a non-default mode (e.g. an executable bit).
	if ((entry.mode & 0o777) !== 0o644) await fs.chmod(resolved, entry.mode & 0o777);
}
