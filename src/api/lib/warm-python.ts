/**
 * WarmPythonProcess — persistent Python interpreter for `py-exec`.
 *
 * Keeps a single `python3` process alive per sandbox session so the ~1.4 s
 * CPython/WASM cold-boot cost is paid at most once (on the first `py-exec`
 * call or at explicit `warmUp()` time).  Subsequent calls run in tens of
 * milliseconds because the interpreter is already running.
 *
 * ## Protocol
 *
 * Rather than using interactive (`-i`) mode (which mixes REPL prompts into
 * stderr), a bootstrap script is embedded at launch time that implements a
 * clean stdin/stdout turn protocol:
 *
 *  Input line (sent to stdin):
 *    `__PYEXEC_SENTINEL_START:<sentinel>:<base64-encoded-code>\n`
 *
 *  Output (written to stdout by the bootstrap, after user code runs):
 *    `<sentinel>:<exitCode>\n`
 *
 * User stdout/stderr from each turn flow through the process's normal
 * stdout/stderr file descriptors — no mixing with protocol traffic.
 *
 * ## Lifecycle
 *
 * - `warmUp()` — start the process; safe to call multiple times (idempotent).
 * - `exec(code, opts)` — execute Python code, returns `{stdout, stderr, exitCode}`.
 * - `kill()` — send SIGTERM; safe to call multiple times (idempotent).
 *
 * ## Limitations / TODO (deferred — see PR body)
 *
 * - Variables persist across calls (interpreter is stateful). Agents that need
 *   isolation between calls should use `python3` (the built-in WASM command).
 * - No stdin forwarding to user code.
 * - If python3 binary is not found at process start, `exec()` rejects on every call.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface WarmPythonExecOptions {
	/** Milliseconds before the execution is considered timed out. Default: 30 000. */
	timeoutMs?: number;
	/** AbortSignal — when aborted, the warm process is killed. */
	signal?: AbortSignal;
}

export interface WarmPythonExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Marker prefix for the protocol input line.
 * Must not appear in normal Python output — long enough to be unique.
 */
const PROTOCOL_PREFIX = "__PYEXEC_SENTINEL_START:";

/** Sentinel suffix pattern: `<sentinel>:<exitCode>` */
const SENTINEL_SUFFIX_RE = /^([0-9a-f-]+):(-?\d+)$/;

/**
 * Bootstrap Python code that the warm process runs on startup.
 * It loops reading protocol lines from stdin, executes the encoded
 * user code, then writes the sentinel + exit-code to stdout.
 */
const BOOTSTRAP_PY = `
import sys, base64
_g = {"__name__": "__main__", "__builtins__": __builtins__}
PREFIX = "${PROTOCOL_PREFIX}"
while True:
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    line = line.rstrip("\\n")
    if not line.startswith(PREFIX):
        continue
    rest = line[len(PREFIX):]
    colon = rest.index(":")
    sentinel, b64 = rest[:colon], rest[colon + 1:]
    rc = 0
    try:
        exec(compile(base64.b64decode(b64).decode("utf-8"), "<py-exec>", "exec"), _g)
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else (1 if e.code else 0)
    except BaseException as e:
        sys.stderr.write(type(e).__name__ + ": " + str(e) + "\\n")
        sys.stderr.flush()
        rc = 1
    sys.stdout.write(sentinel + ":" + str(rc) + "\\n")
    sys.stdout.flush()
`.trim();

export class WarmPythonProcess {
	private proc: ChildProcess | undefined;
	private spawnError: Error | undefined;
	private stdoutBuf = "";
	private stderrBuf = "";
	private pendingResolve: ((result: WarmPythonExecResult) => void) | undefined;
	private pendingReject: ((err: Error) => void) | undefined;
	private currentSentinel: string | undefined;
	private dead = false;

	/**
	 * Spawn the Python interpreter with the embedded bootstrap.
	 * Idempotent — subsequent calls return immediately.
	 */
	warmUp(): void {
		if (this.proc !== undefined || this.dead) return;

		// Embed the bootstrap as base64 to avoid any shell-quoting hazards.
		const bootstrapB64 = Buffer.from(BOOTSTRAP_PY, "utf8").toString("base64");

		try {
			this.proc = spawn("python3", ["-u", "-c", `import base64; exec(base64.b64decode("${bootstrapB64}").decode())`], {
				env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			this.spawnError = err instanceof Error ? err : new Error(String(err));
			return;
		}

		this.proc.on("error", (err) => {
			this.spawnError = err;
			this.dead = true;
			this.rejectPending(err);
		});

		this.proc.on("exit", (code, signal) => {
			this.dead = true;
			const err = Object.assign(
				new Error(
					`py-exec: warm Python process exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"})`,
				),
				{ code: "EPYEXEC_DIED" as const },
			);
			this.rejectPending(err);
		});

		this.proc.stdout!.setEncoding("utf8");
		this.proc.stdout!.on("data", (chunk: string) => {
			this.stdoutBuf += chunk;
			this.trySettle();
		});

		this.proc.stderr!.setEncoding("utf8");
		this.proc.stderr!.on("data", (chunk: string) => {
			this.stderrBuf += chunk;
		});
	}

	/**
	 * Execute Python `code` inside the warm interpreter.
	 *
	 * The warm process is spawned on first call if not already running.
	 */
	exec(code: string, opts?: WarmPythonExecOptions): Promise<WarmPythonExecResult> {
		if (!this.dead && this.proc === undefined) {
			this.warmUp();
		}

		if (this.spawnError !== undefined) {
			return Promise.reject(this.spawnError);
		}
		if (this.dead) {
			return Promise.reject(
				Object.assign(new Error("py-exec: warm Python process has exited"), { code: "EPYEXEC_DIED" as const }),
			);
		}

		if (this.pendingResolve !== undefined) {
			return Promise.reject(
				Object.assign(new Error("py-exec: concurrent execution not supported; serialise calls"), {
					code: "EPYEXEC_BUSY" as const,
				}),
			);
		}

		const sentinel = randomUUID();
		const timeoutMs = opts?.timeoutMs ?? 30_000;

		return new Promise<WarmPythonExecResult>((resolve, reject) => {
			// AbortSignal support
			if (opts?.signal?.aborted) {
				reject(Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" }));
				return;
			}
			const onAbort = (): void => {
				this.kill();
				reject(Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" }));
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(() => {
				opts?.signal?.removeEventListener("abort", onAbort);
				this.kill();
				reject(
					Object.assign(new Error(`py-exec: execution timed out after ${timeoutMs}ms`), {
						code: "EPYEXEC_TIMEOUT" as const,
					}),
				);
			}, timeoutMs);

			this.pendingResolve = (result) => {
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			this.pendingReject = (err) => {
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				reject(err);
			};
			this.currentSentinel = sentinel;

			// Base64-encode user code to avoid any quoting / injection hazards.
			const b64 = Buffer.from(code, "utf8").toString("base64");

			// Send the protocol line.
			this.proc!.stdin!.write(`${PROTOCOL_PREFIX}${sentinel}:${b64}\n`);
		});
	}

	/** Kill the warm process immediately. Idempotent. */
	kill(): void {
		if (this.proc !== undefined && !this.dead) {
			this.dead = true;
			try {
				this.proc.kill("SIGTERM");
			} catch {
				// best-effort
			}
		}
	}

	/** True if the process has been started and has not yet exited. */
	get isAlive(): boolean {
		return this.proc !== undefined && !this.dead;
	}

	// ── private ──────────────────────────────────────────────────────────────

	private trySettle(): void {
		if (this.pendingResolve === undefined || this.currentSentinel === undefined) return;

		// The bootstrap writes `<sentinel>:<exitCode>\n` to stdout.
		// Scan line-by-line for the sentinel.
		const lines = this.stdoutBuf.split("\n");
		const sentinelIdx = lines.findIndex((l) => {
			const match = SENTINEL_SUFFIX_RE.exec(l);
			return match !== null && match[1] === this.currentSentinel;
		});
		if (sentinelIdx === -1) return;

		// User stdout is everything before the sentinel line.
		const userLines = lines.slice(0, sentinelIdx);
		const remainingLines = lines.slice(sentinelIdx + 1);
		const sentinelLine = lines[sentinelIdx]!;
		const match = SENTINEL_SUFFIX_RE.exec(sentinelLine);
		const exitCode = match !== null ? Number(match[2]) : 0;

		// Carry over any data that arrived after the sentinel.
		this.stdoutBuf = remainingLines.join("\n");

		// Drain accumulated stderr for this turn.
		const stderrOut = this.stderrBuf.trimEnd();
		this.stderrBuf = "";

		const resolve = this.pendingResolve;
		this.pendingResolve = undefined;
		this.pendingReject = undefined;
		this.currentSentinel = undefined;

		const stdoutOut = userLines.join("\n").trimEnd();
		resolve({
			stdout: stdoutOut.length > 0 ? `${stdoutOut}\n` : "",
			stderr: stderrOut.length > 0 ? `${stderrOut}\n` : "",
			exitCode,
		});
	}

	private rejectPending(err: Error): void {
		if (this.pendingReject !== undefined) {
			const reject = this.pendingReject;
			this.pendingResolve = undefined;
			this.pendingReject = undefined;
			this.currentSentinel = undefined;
			reject(err);
		}
	}
}

/**
 * Create a `py-exec` custom command backed by the given `WarmPythonProcess`.
 *
 * Usage inside the sandbox:
 *
 *   py-exec -c 'print("hello")'          # inline code
 *   py-exec /path/to/script.py           # run a file (reads via ctx.fs)
 *
 * Flags:
 *   -c <code>   Inline Python code string (like `python3 -c`).
 *
 * Exit codes mirror the Python script's exit code.
 */
export function createPyExecCommand(warm: WarmPythonProcess): import("just-bash").Command {
	return {
		name: "py-exec",
		trusted: false,
		async execute(args, ctx): Promise<import("just-bash").ExecResult> {
			let code: string;

			if (args[0] === "-c") {
				const inline = args.slice(1).join(" ");
				if (inline.length === 0) {
					return { stdout: "", stderr: "py-exec: -c requires an argument\n", exitCode: 1 };
				}
				code = inline;
			} else if (args.length > 0 && args[0] !== undefined && !args[0].startsWith("-")) {
				const scriptPath = args[0];
				let raw: string;
				try {
					raw = await ctx.fs.readFile(scriptPath);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return { stdout: "", stderr: `py-exec: cannot read '${scriptPath}': ${msg}\n`, exitCode: 1 };
				}
				code = raw;
			} else {
				return {
					stdout: "",
					stderr: "py-exec: usage: py-exec -c <code>  |  py-exec <script.py>\n",
					exitCode: 1,
				};
			}

			let result: WarmPythonExecResult;
			try {
				result = await warm.exec(code, { signal: ctx.signal });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { stdout: "", stderr: `py-exec: ${msg}\n`, exitCode: 1 };
			}

			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
			};
		},
	};
}
