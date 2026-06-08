/**
 * Node-side `PyodideSandbox` — the TRUSTED half of the Pyodide runtime.
 *
 * Owns one Deno subprocess (the untrusted `runner.ts`), frames the IPC with full
 * integrity validation, serializes `run()` calls, and enforces throw-not-return
 * cancellation + lazy respawn. No session wiring yet (Phase 5) — unit-testable in
 * isolation against a fake child via the injectable `spawnFn`.
 *
 * Spawn posture (design + Phase 3 Discoveries): the child is launched with the
 * committed deny-belt verbatim. Node resolves the asset dir from its own env
 * BEFORE spawn and passes it LITERALLY in both `--allow-read=<assetDir>` and as a
 * runner argv — never via the child env, which is scrubbed to ONLY
 * `{ DENO_NO_UPDATE_CHECK: "1" }` (no AUTH_SECRET/DATABASE_URL; the child does not
 * inherit the parent env). `spawn` uses no shell, so `$VAR` is never expanded.
 *
 * Cancellation is state-dependent and NEVER kills an innocent active request:
 *   - abort while still queued (before this call acquires the mutex): remove only
 *     this waiter and reject it with AbortError; the child is NOT killed and any
 *     concurrently-active run() is unaffected.
 *   - abort after acquiring the mutex (this call now owns the child — during
 *     init/preload or mid-run) OR an internal runtime timeout: SIGKILL the child
 *     and retire the generation; reject/throw (never return a normal result).
 *   - unexpected child exit or any IpcIntegrityError: mark dead, reject the
 *     in-flight run(), and respawn lazily with an incremented generation on the
 *     next run().
 */

import { Buffer } from "node:buffer";
import { type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Frame, RunRequest, RunResponse } from "../../pyodide-runner/protocol.js";
import {
	type InboundContext,
	IpcIntegrityError,
	PYODIDE_MAX_AGGREGATE_BYTES_DEFAULT,
	PYODIDE_MAX_FRAME_BYTES_DEFAULT,
	asRunResponse,
	decodeFrames,
	encodeFrame,
	validateInbound,
} from "./ipc.js";

/** Worker lifecycle state. */
export type WorkerState = "cold" | "starting" | "idle" | "busy" | "terminating" | "dead";

/**
 * A `run()` payload WITHOUT the integrity fields. The manager assigns
 * `requestId` / `seq` / `generation` itself — they are unguessable secrets it
 * must never accept from a caller (and never expose to the child's Python).
 */
export type RunRequestInput = Omit<RunRequest, "type" | "requestId" | "seq" | "generation">;

/**
 * The committed deny-belt — MUST match `runner.ts`'s documented flags and the
 * Phase 3 verification harness exactly. `--allow-read=<assetDir>` is appended at
 * spawn time (the only granted capability).
 */
export const COMMITTED_FLAGS: readonly string[] = [
	"--no-prompt",
	"--deny-net",
	"--deny-run",
	"--deny-write",
	"--deny-env",
	"--deny-ffi",
	"--deny-sys",
	"--deny-import",
	"--no-remote",
	"--no-npm",
	"--cached-only",
	"--no-config",
];

/** Default cap on a single owned run (init/preload + execution). */
export const PYODIDE_RUNTIME_TIMEOUT_MS_DEFAULT = 60_000;

/** Injectable spawn signature (defaults to `child_process.spawn`). */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface PyodideSandboxOptions {
	/** Absolute asset dir (resolved by Node before spawn). Falls back to PYODIDE_ASSET_DIR. */
	readonly assetDir?: string;
	/** Deno binary path. Falls back to DENO_BIN_PATH, then "deno". */
	readonly denoBin?: string;
	/** Path to the runner entry. Defaults to the vendored `dist/pyodide-runner/runner.ts`. */
	readonly runnerPath?: string;
	/** Cap on a single owned run (ms). Default {@link PYODIDE_RUNTIME_TIMEOUT_MS_DEFAULT}. */
	readonly runtimeTimeoutMs?: number;
	/** Per-frame wire cap (bytes). Default {@link PYODIDE_MAX_FRAME_BYTES_DEFAULT}. */
	readonly maxFrameBytes?: number;
	/** Aggregate per-response wire cap (bytes). Default {@link PYODIDE_MAX_AGGREGATE_BYTES_DEFAULT}. */
	readonly maxAggregateBytes?: number;
	/** Injected spawn (tests). Defaults to `child_process.spawn`. */
	readonly spawnFn?: SpawnFn;
	/** Injected requestId generator (tests). Defaults to `crypto.randomUUID`. */
	readonly randomRequestId?: () => string;
}

/** Thrown when an owned run exceeds {@link PyodideSandboxOptions.runtimeTimeoutMs}. */
export class PyodideTimeoutError extends Error {
	readonly code = "EPYODIDE_TIMEOUT";
	constructor(ms: number) {
		super(`EPYODIDE_TIMEOUT: pyodide run exceeded ${ms}ms`);
		this.name = "PyodideTimeoutError";
	}
}

/** Thrown when the child exits unexpectedly while a run is in flight. */
export class PyodideChildExitError extends Error {
	readonly code = "EPYODIDE_CHILD_EXIT";
	constructor(
		readonly exitCode: number | null,
		readonly exitSignal: NodeJS.Signals | null,
	) {
		super(`EPYODIDE_CHILD_EXIT: pyodide child exited (code=${exitCode}, signal=${exitSignal})`);
		this.name = "PyodideChildExitError";
	}
}

/** Thrown by an in-flight run() when the manager is disposed. */
export class PyodideDisposedError extends Error {
	readonly code = "EPYODIDE_DISPOSED";
	constructor() {
		super("EPYODIDE_DISPOSED: pyodide sandbox disposed");
		this.name = "PyodideDisposedError";
	}
}

function makeAbortError(): Error {
	return Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" });
}

/** A waiter parked in the serialization queue (mirrors session-manager's pattern). */
interface QueueWaiter {
	resolve: () => void;
	reject: (err: Error) => void;
	readonly signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
	settled: boolean;
}

/** The single owned operation currently holding the child (init + run). */
interface OwnedOp {
	readonly input: RunRequestInput;
	readonly resolve: (r: RunResponse) => void;
	readonly reject: (e: Error) => void;
	readonly signal: AbortSignal;
	readonly onAbort: () => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	stage: "ready" | "response";
	requestId: string;
	seq: number;
	done: boolean;
}

const DEFAULT_RUNNER_PATH = fileURLToPath(new URL("../../pyodide-runner/runner.ts", import.meta.url));

export class PyodideSandbox {
	#state: WorkerState = "cold";
	#generation = 0;
	#child: ChildProcess | null = null;
	#readBuf: Buffer = Buffer.alloc(0);
	#aggregateBytes = 0;
	#readyReceived = false;
	#seqCounter = 0;
	#pending: { requestId: string; seq: number } | null = null;
	#current: OwnedOp | null = null;
	#disposed = false;

	// Serialization lock (one run owns the child at a time).
	#locked = false;
	readonly #queue: QueueWaiter[] = [];

	readonly #assetDir: string;
	readonly #denoBin: string;
	readonly #runnerPath: string;
	readonly #runtimeTimeoutMs: number;
	readonly #maxFrameBytes: number;
	readonly #maxAggregateBytes: number;
	readonly #spawnFn: SpawnFn;
	readonly #randomRequestId: () => string;

	constructor(opts: PyodideSandboxOptions = {}) {
		this.#assetDir = opts.assetDir ?? process.env.PYODIDE_ASSET_DIR ?? "";
		this.#denoBin = opts.denoBin ?? process.env.DENO_BIN_PATH ?? "deno";
		this.#runnerPath = opts.runnerPath ?? DEFAULT_RUNNER_PATH;
		this.#runtimeTimeoutMs = opts.runtimeTimeoutMs ?? PYODIDE_RUNTIME_TIMEOUT_MS_DEFAULT;
		this.#maxFrameBytes = opts.maxFrameBytes ?? PYODIDE_MAX_FRAME_BYTES_DEFAULT;
		this.#maxAggregateBytes = opts.maxAggregateBytes ?? PYODIDE_MAX_AGGREGATE_BYTES_DEFAULT;
		this.#spawnFn = opts.spawnFn ?? (nodeSpawn as SpawnFn);
		this.#randomRequestId = opts.randomRequestId ?? randomUUID;
	}

	get state(): WorkerState {
		return this.#state;
	}

	/** The current (live) child generation; 0 before the first spawn. */
	get generation(): number {
		return this.#generation;
	}

	/**
	 * Run untrusted Python on the owned child, serialized behind any prior run().
	 * Resolves with the `result`/`error` response (the caller inspects `exitCode`).
	 * Rejects with AbortError on cancellation, {@link PyodideTimeoutError} on an
	 * internal timeout, or {@link IpcIntegrityError}/{@link PyodideChildExitError}
	 * on a channel/child failure. Never returns a normal result for a
	 * timed-out/aborted run.
	 */
	async run(input: RunRequestInput, signal: AbortSignal): Promise<RunResponse> {
		if (this.#disposed) throw new PyodideDisposedError();
		// Abort while still queued → reject only this waiter; do NOT kill the child.
		await this.#acquire(signal);
		try {
			if (this.#disposed) throw new PyodideDisposedError();
			return await this.#executeOwned(input, signal);
		} finally {
			this.#release();
		}
	}

	/** Permanently terminate the child and reject any in-flight run(). Terminal. */
	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#state = "terminating";
		this.#failOwned(new PyodideDisposedError(), /* respawnable */ false);
		// Drain queued waiters so parked run() callers reject rather than hang.
		while (this.#queue.length > 0) {
			const w = this.#queue.shift();
			if (w && !w.settled) w.reject(new PyodideDisposedError());
		}
		this.#killChild();
		this.#state = "dead";
		await Promise.resolve();
	}

	// ── Serialization queue (abort-while-queued = remove waiter, no kill) ─────────

	#acquire(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(makeAbortError());
		if (!this.#locked) {
			this.#locked = true;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: QueueWaiter = {
				resolve: () => {
					if (waiter.settled) return;
					waiter.settled = true;
					if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
					resolve();
				},
				reject: (err: Error) => {
					if (waiter.settled) return;
					waiter.settled = true;
					if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
					const idx = this.#queue.indexOf(waiter);
					if (idx >= 0) this.#queue.splice(idx, 1);
					reject(err);
				},
				signal,
				onAbort: undefined,
				settled: false,
			};
			const onAbort = (): void => waiter.reject(makeAbortError());
			waiter.onAbort = onAbort;
			signal.addEventListener("abort", onAbort, { once: true });
			this.#queue.push(waiter);
		});
	}

	#release(): void {
		while (this.#queue.length > 0) {
			const next = this.#queue.shift();
			if (next === undefined) break;
			if (next.settled) continue;
			next.resolve();
			return;
		}
		this.#locked = false;
	}

	// ── Owned section: this call holds the child (init/preload + run) ────────────

	#executeOwned(input: RunRequestInput, signal: AbortSignal): Promise<RunResponse> {
		return new Promise<RunResponse>((resolve, reject) => {
			const op: OwnedOp = {
				input,
				resolve,
				reject,
				signal,
				onAbort: () => this.#failOwned(makeAbortError(), true),
				timer: undefined,
				stage: "ready",
				requestId: "",
				seq: -1,
				done: false,
			};
			this.#current = op;

			if (signal.aborted) {
				this.#failOwned(makeAbortError(), true);
				return;
			}
			signal.addEventListener("abort", op.onAbort, { once: true });
			op.timer = setTimeout(
				() => this.#failOwned(new PyodideTimeoutError(this.#runtimeTimeoutMs), true),
				this.#runtimeTimeoutMs,
			);

			// Warm reuse if the child is alive + handshaked; otherwise (re)spawn and
			// await `ready` (its dispatch will send the run frame).
			if (this.#state === "idle" && this.#readyReceived && this.#child !== null) {
				this.#sendRunFrame(op);
				return;
			}
			try {
				this.#spawnChild();
			} catch (err) {
				this.#failOwned(err instanceof Error ? err : new Error(String(err)), true);
			}
		});
	}

	#sendRunFrame(op: OwnedOp): void {
		if (op.done) return;
		const frame: RunRequest = {
			type: "run",
			requestId: this.#randomRequestId(),
			seq: ++this.#seqCounter,
			generation: this.#generation,
			code: op.input.code,
			argv: op.input.argv,
			stdin: op.input.stdin,
			files: op.input.files,
			cwd: op.input.cwd,
		};
		op.requestId = frame.requestId;
		op.seq = frame.seq;
		op.stage = "response";
		this.#pending = { requestId: frame.requestId, seq: frame.seq };
		this.#state = "busy";
		const child = this.#child;
		if (child?.stdin === null || child?.stdin === undefined) {
			this.#failOwned(new PyodideChildExitError(null, null), true);
			return;
		}
		try {
			child.stdin.write(encodeFrame(frame));
		} catch (err) {
			this.#failOwned(err instanceof Error ? err : new Error(String(err)), true);
		}
	}

	/**
	 * Fail the in-flight owned run (if any), SIGKILL the child, and retire its
	 * generation. `respawnable` distinguishes a recoverable kill (next run()
	 * respawns) from dispose (terminal). Safe to call with no in-flight op (a
	 * forged frame while idle still kills the child).
	 */
	#failOwned(err: Error, respawnable: boolean): void {
		const op = this.#current;
		this.#killChild();
		if (op && !op.done) {
			op.done = true;
			if (op.timer !== undefined) clearTimeout(op.timer);
			op.signal.removeEventListener("abort", op.onAbort);
			this.#current = null;
			op.reject(err);
		}
		if (!respawnable) this.#state = "dead";
	}

	// ── Child lifecycle ──────────────────────────────────────────────────────────

	#spawnChild(): void {
		this.#generation += 1;
		const gen = this.#generation;
		const args = [
			"run",
			...COMMITTED_FLAGS,
			`--allow-read=${this.#assetDir}`,
			this.#runnerPath,
			this.#assetDir,
			String(gen),
		];
		const child = this.#spawnFn(this.#denoBin, args, {
			// Scrubbed env: NO parent env inheritance, NO secrets — only the
			// update-check suppressor the Deno runtime reads itself.
			env: { DENO_NO_UPDATE_CHECK: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child = child;
		this.#readyReceived = false;
		this.#pending = null;
		this.#readBuf = Buffer.alloc(0);
		this.#aggregateBytes = 0;
		this.#state = "starting";

		// Bind handlers to THIS child so late events from a retired generation are
		// ignored after respawn.
		child.stdout?.on("data", (chunk: Buffer) => {
			if (this.#child !== child) return;
			this.#onStdoutData(chunk);
		});
		child.on("exit", (code: number | null, sig: NodeJS.Signals | null) => {
			if (this.#child !== child) return;
			this.#onChildExit(code, sig);
		});
		child.on("error", (err: Error) => {
			if (this.#child !== child) return;
			this.#failOwned(err, true);
		});
	}

	#killChild(): void {
		const child = this.#child;
		this.#child = null;
		this.#readyReceived = false;
		this.#pending = null;
		this.#readBuf = Buffer.alloc(0);
		this.#aggregateBytes = 0;
		if (this.#state !== "terminating") this.#state = "dead";
		if (child) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}

	#onChildExit(code: number | null, sig: NodeJS.Signals | null): void {
		// A kill we initiated already set state to dead/terminating.
		if (this.#state === "dead" || this.#state === "terminating") return;
		this.#failOwned(new PyodideChildExitError(code, sig), true);
	}

	// ── Inbound frame processing (the load-bearing security path) ─────────────────

	#isTerminal(): boolean {
		return this.#state === "dead" || this.#state === "terminating";
	}

	#onStdoutData(chunk: Buffer): void {
		if (this.#isTerminal()) return;
		this.#aggregateBytes += chunk.byteLength;
		if (this.#aggregateBytes > this.#maxAggregateBytes) {
			this.#failOwned(new IpcIntegrityError("aggregate response bytes exceeded cap"), true);
			return;
		}
		this.#readBuf = this.#readBuf.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.#readBuf, chunk]);

		let decoded: { frames: ReturnType<typeof decodeFrames>["frames"]; rest: Buffer };
		try {
			decoded = decodeFrames(this.#readBuf, this.#maxFrameBytes);
		} catch (err) {
			this.#failOwned(err instanceof Error ? err : new Error(String(err)), true);
			return;
		}
		this.#readBuf = decoded.rest;

		for (const frame of decoded.frames) {
			const ctx: InboundContext = {
				generation: this.#generation,
				ready: this.#readyReceived,
				pending: this.#pending ? { requestId: this.#pending.requestId, seq: this.#pending.seq } : null,
			};
			try {
				validateInbound(frame, ctx);
			} catch (err) {
				this.#failOwned(err instanceof Error ? err : new Error(String(err)), true);
				return;
			}
			this.#dispatchFrame(frame);
			if (this.#isTerminal()) return;
		}
	}

	#dispatchFrame(frame: Frame): void {
		// Reset the aggregate window on each accepted complete frame.
		this.#aggregateBytes = this.#readBuf.byteLength;

		if (frame.type === "ready") {
			this.#readyReceived = true;
			const op = this.#current;
			if (op && !op.done && op.stage === "ready") {
				this.#sendRunFrame(op); // transitions to busy
			} else {
				this.#state = "idle";
			}
			return;
		}

		// result | error — validated as the single response to #pending / #current.
		const op = this.#current;
		this.#pending = null;
		this.#state = "idle";
		if (op && !op.done) {
			op.done = true;
			if (op.timer !== undefined) clearTimeout(op.timer);
			op.signal.removeEventListener("abort", op.onAbort);
			this.#current = null;
			op.resolve(asRunResponse(frame));
		}
	}
}
