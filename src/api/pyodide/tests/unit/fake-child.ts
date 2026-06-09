/**
 * Fake Deno child for PyodideSandbox unit tests — no real Deno/Pyodide needed.
 *
 * Models the runner's IPC surface: it reads the manager's length-prefixed `run`
 * frames off `stdin` and lets the test drive `ready`/`result`/`error`/raw bytes
 * onto `stdout`. The fake's `generation` is taken from the last spawn argv
 * (exactly as the real runner reads it), so it echoes the generation it was
 * launched with unless a test deliberately forges otherwise.
 */

import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Frame, RunRequest, RunResponse } from "../../../../pyodide-runner/protocol.js";
import { decodeFrames, encodeFrame } from "../../ipc.js";
import type { SpawnFn } from "../../manager.js";

/** Minimal stream: `write` delivers `data` on a microtask (deterministic in tests). */
class FakeStream extends EventEmitter {
	write(chunk: Buffer | string): boolean {
		const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		queueMicrotask(() => this.emit("data", buf));
		return true;
	}
}

export class FakeChild extends EventEmitter {
	readonly stdin = new FakeStream();
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	readonly pid = 4242;
	readonly generation: number;
	readonly runs: RunRequest[] = [];

	killed = false;
	killSignal: string | undefined;
	exited = false;

	readonly #pendingRuns: RunRequest[] = [];
	readonly #runWaiters: ((r: RunRequest) => void)[] = [];

	constructor(generation: number) {
		super();
		this.generation = generation;
		this.stdin.on("data", (buf: Buffer) => {
			for (const frame of decodeFrames(buf).frames) {
				if (frame.type !== "run") continue;
				const run = frame as RunRequest;
				this.runs.push(run);
				const waiter = this.#runWaiters.shift();
				if (waiter) waiter(run);
				else this.#pendingRuns.push(run);
			}
		});
	}

	/** Await the next `run` frame the manager writes to stdin. */
	nextRun(): Promise<RunRequest> {
		const buffered = this.#pendingRuns.shift();
		if (buffered) return Promise.resolve(buffered);
		return new Promise<RunRequest>((resolve) => this.#runWaiters.push(resolve));
	}

	sendFrame(frame: Frame): void {
		this.stdout.write(encodeFrame(frame));
	}

	/** Emit a raw (possibly malformed) length-prefixed body — for integrity tests. */
	sendRaw(body: Buffer): void {
		const buf = Buffer.allocUnsafe(4 + body.byteLength);
		buf.writeUInt32BE(body.byteLength, 0);
		body.copy(buf, 4);
		this.stdout.write(buf);
	}

	sendReady(generation: number = this.generation): void {
		this.sendFrame({ type: "ready", generation });
	}

	sendResult(run: RunRequest, over: Partial<RunResponse> = {}): void {
		this.sendFrame({
			type: "result",
			requestId: run.requestId,
			seq: run.seq,
			generation: this.generation,
			stdout: "",
			stderr: "",
			exitCode: 0,
			created: [],
			modified: [],
			deleted: [],
			...over,
		});
	}

	/** Simulate an unexpected process exit (crash / OOM-kill). */
	exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		if (this.exited) return;
		this.exited = true;
		this.emit("exit", code, signal);
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		if (this.killed) return false;
		this.killed = true;
		this.killSignal = typeof signal === "string" ? signal : "SIGKILL";
		queueMicrotask(() => this.exit(null, (typeof signal === "string" ? signal : "SIGKILL") as NodeJS.Signals));
		return true;
	}
}

export interface Harness {
	readonly spawnFn: SpawnFn;
	/** Await the next spawned child (resolves in spawn order). */
	nextChild(): Promise<FakeChild>;
	/** Every child spawned so far, in order. */
	readonly children: FakeChild[];
}

export function makeHarness(): Harness {
	const children: FakeChild[] = [];
	const ready: FakeChild[] = [];
	const waiters: ((c: FakeChild) => void)[] = [];

	const spawnFn: SpawnFn = (_cmd, args) => {
		// The runner reads its generation from the final argv — the fake does too.
		const generation = Number(args[args.length - 1]);
		const child = new FakeChild(generation);
		children.push(child);
		const waiter = waiters.shift();
		if (waiter) waiter(child);
		else ready.push(child);
		return child as unknown as ChildProcess;
	};

	const nextChild = (): Promise<FakeChild> => {
		const buffered = ready.shift();
		if (buffered) return Promise.resolve(buffered);
		return new Promise<FakeChild>((resolve) => waiters.push(resolve));
	};

	return { spawnFn, nextChild, children };
}

/** Flush pending microtasks so queued stream `data` events deliver. */
export function flush(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}
