/**
 * Unit tests for the Node-side PyodideSandbox manager (`src/api/pyodide/manager.ts`).
 *
 * Driven entirely by a fake child (no real Deno/Pyodide). Each test names the
 * design decision it protects. The integrity cases assert the spike-S2 invariant:
 * any forged / interleaved / replayed / stale-generation / bad-handshake frame
 * kills the child — it is never accepted.
 */

import { Buffer } from "node:buffer";
import type { SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { IpcFrameTooLargeError, IpcIntegrityError } from "../../ipc.js";
import type { RunRequestInput } from "../../manager.js";
import {
	COMMITTED_FLAGS,
	PyodideChildExitError,
	PyodideDisposedError,
	PyodideSandbox,
	PyodideTimeoutError,
} from "../../manager.js";
import { type FakeChild, type Harness, flush, makeHarness } from "./fake-child.js";

const INPUT: RunRequestInput = { code: "print(1)", argv: ["x.py"], stdin: "", files: [], cwd: "/home/pyodide" };

let seq = 0;
function makeManager(
	harness: Harness,
	opts: { runtimeTimeoutMs?: number; maxFrameBytes?: number; maxAggregateBytes?: number } = {},
): PyodideSandbox {
	return new PyodideSandbox({
		assetDir: "/vendor/pyodide",
		denoBin: "/vendor/deno/deno",
		runnerPath: "/dist/pyodide-runner/runner.ts",
		spawnFn: harness.spawnFn,
		// Deterministic requestIds so a forged frame can't accidentally match.
		randomRequestId: () => `req-${++seq}`,
		runtimeTimeoutMs: opts.runtimeTimeoutMs ?? 5_000,
		maxFrameBytes: opts.maxFrameBytes,
		maxAggregateBytes: opts.maxAggregateBytes,
	});
}

const sandboxes: PyodideSandbox[] = [];
function track(s: PyodideSandbox): PyodideSandbox {
	sandboxes.push(s);
	return s;
}

afterEach(async () => {
	for (const s of sandboxes.splice(0)) await s.dispose();
});

/** Spawn + handshake a child, run one request to completion, return [resp, child]. */
async function warmRun(manager: PyodideSandbox, harness: Harness, signal: AbortSignal): Promise<FakeChild> {
	const p = manager.run(INPUT, signal);
	const child = await harness.nextChild();
	child.sendReady();
	const run = await child.nextRun();
	child.sendResult(run);
	await p;
	return child;
}

describe("PyodideSandbox — happy path & serialization", () => {
	it("spawns lazily, handshakes, and returns the matching response", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));
		expect(manager.state).toBe("cold");
		expect(manager.generation).toBe(0);

		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		expect(manager.state).toBe("starting");
		expect(manager.generation).toBe(1);
		expect(child.generation).toBe(1);

		child.sendReady();
		const run = await child.nextRun();
		expect(run.requestId).toBe("req-1");
		expect(run.seq).toBe(1);
		expect(run.generation).toBe(1);
		// Integrity secrets must NEVER cross into the request payload's user fields.
		expect(run.code).toBe(INPUT.code);

		child.sendResult(run, { stdout: Buffer.from("1\n").toString("base64"), exitCode: 0 });
		const resp = await p;
		expect(resp.type).toBe("result");
		expect(resp.exitCode).toBe(0);
		expect(Buffer.from(resp.stdout, "base64").toString()).toBe("1\n");
		expect(manager.state).toBe("idle");
	});

	it("serializes two overlapping run() calls in submission order and reuses the warm child", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));
		const order: number[] = [];

		const p1 = manager.run(INPUT, new AbortController().signal).then((r) => {
			order.push(1);
			return r;
		});
		const child = await harness.nextChild();
		child.sendReady();
		const run1 = await child.nextRun();

		// Queue the second call while the first is busy.
		const p2 = manager.run(INPUT, new AbortController().signal).then((r) => {
			order.push(2);
			return r;
		});
		await flush();
		expect(child.runs).toHaveLength(1); // run2 is parked behind run1

		child.sendResult(run1);
		await p1;
		// run2 now reuses the SAME warm child (no respawn, no second handshake).
		const run2 = await child.nextRun();
		expect(run2.seq).toBe(2);
		child.sendResult(run2);
		await p2;

		expect(order).toEqual([1, 2]);
		expect(harness.children).toHaveLength(1);
	});
});

describe("PyodideSandbox — cancellation", () => {
	it("abort while queued removes only that waiter; the active run is unaffected and the child survives", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));

		const p1 = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		child.sendReady();
		const run1 = await child.nextRun(); // run1 active (busy), holds the lock

		const ac2 = new AbortController();
		const p2 = manager.run(INPUT, ac2.signal);
		await flush();

		ac2.abort();
		await expect(p2).rejects.toMatchObject({ name: "AbortError", code: "ABORTED" });
		expect(child.killed).toBe(false); // queued abort must NOT kill the child
		expect(manager.state).toBe("busy"); // run1 still active

		child.sendResult(run1);
		const resp1 = await p1;
		expect(resp1.exitCode).toBe(0); // active run completed normally
	});

	it("abort after acquiring the mutex (during init) kills the child and retires the generation", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));

		const ac = new AbortController();
		const p = manager.run(INPUT, ac.signal);
		const child = await harness.nextChild(); // spawned, awaiting ready (never sent)
		expect(manager.state).toBe("starting");

		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		expect(child.killed).toBe(true);
		expect(child.killSignal).toBe("SIGKILL");
		expect(manager.state).toBe("dead");

		// Generation retired: the next run respawns with an incremented generation.
		const p2 = manager.run(INPUT, new AbortController().signal);
		const child2 = await harness.nextChild();
		expect(child2.generation).toBe(2);
		expect(manager.generation).toBe(2);
		child2.sendReady();
		child2.sendResult(await child2.nextRun());
		await p2;
	});

	it("internal timeout during init throws PyodideTimeoutError and kills the child", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness, { runtimeTimeoutMs: 25 }));

		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild(); // never handshakes
		await expect(p).rejects.toBeInstanceOf(PyodideTimeoutError);
		expect(child.killed).toBe(true);
		expect(manager.state).toBe("dead");
	});

	it("internal timeout mid-run throws PyodideTimeoutError and kills the child", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness, { runtimeTimeoutMs: 25 }));

		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		child.sendReady();
		await child.nextRun(); // run frame sent, busy, but no response ever comes
		await expect(p).rejects.toBeInstanceOf(PyodideTimeoutError);
		expect(child.killed).toBe(true);
	});

	it("rejects an already-aborted signal without spawning", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));
		const ac = new AbortController();
		ac.abort();
		await expect(manager.run(INPUT, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(harness.children).toHaveLength(0);
	});
});

describe("PyodideSandbox — respawn on exit", () => {
	it("an unexpected child exit marks dead and the next run respawns with an incremented generation", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));

		const c1 = await warmRun(manager, harness, new AbortController().signal);
		expect(c1.generation).toBe(1);
		expect(manager.generation).toBe(1);

		c1.exit(1, null); // crash / OOM-kill while idle
		await flush();
		expect(manager.state).toBe("dead");

		const c2 = await warmRun(manager, harness, new AbortController().signal);
		expect(c2.generation).toBe(2);
		expect(manager.generation).toBe(2);
		expect(harness.children).toHaveLength(2);
	});

	it("an in-flight run rejects when the child exits unexpectedly", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));
		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		child.sendReady();
		await child.nextRun();
		child.exit(137, "SIGKILL"); // OOM
		await expect(p).rejects.toBeInstanceOf(PyodideChildExitError);
		expect(manager.state).toBe("dead");
	});
});

describe("PyodideSandbox — frame integrity (each violation kills the child)", () => {
	async function inFlight(opts?: { maxFrameBytes?: number }): Promise<{
		manager: PyodideSandbox;
		harness: Harness;
		child: FakeChild;
		p: Promise<unknown>;
		run: Awaited<ReturnType<FakeChild["nextRun"]>>;
	}> {
		const harness = makeHarness();
		const manager = track(makeManager(harness, opts));
		const p = manager.run(INPUT, new AbortController().signal).catch((e) => e);
		const child = await harness.nextChild();
		child.sendReady();
		const run = await child.nextRun();
		return { manager, harness, child, p, run };
	}

	it("forged requestId → kill", async () => {
		const { child, p, run, manager } = await inFlight();
		child.sendResult(run, { requestId: "forged" });
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
		expect(manager.state).toBe("dead");
	});

	it("out-of-sequence seq → kill", async () => {
		const { child, p, run } = await inFlight();
		child.sendResult(run, { seq: 999 });
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
	});

	it("stale / wrong generation → kill", async () => {
		const { child, p, run } = await inFlight();
		child.sendResult(run, { generation: 0 });
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
	});

	it("malformed JSON → kill", async () => {
		const { child, p } = await inFlight();
		child.sendRaw(Buffer.from("{ not json", "utf8"));
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
	});

	it("a malformed drain entry (integrity-valid frame, bad created[]) → kill", async () => {
		const { child, p, run, manager } = await inFlight();
		// Correct requestId/seq/generation, but a created entry that is not an FsEntry.
		child.sendResult(run, { created: [{ path: "/x" }] as never });
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
		expect(manager.state).toBe("dead");
	});

	it("oversized frame (base64 wire size over cap) → kill", async () => {
		const { child, p, run } = await inFlight({ maxFrameBytes: 200 });
		// 1 KiB raw → ~1368 base64 chars in the body, well over the 200-byte cap.
		child.sendResult(run, { stdout: Buffer.alloc(1024, 0x41).toString("base64") });
		expect(await p).toBeInstanceOf(IpcFrameTooLargeError);
		expect(child.killed).toBe(true);
	});

	it("a duplicate / replayed response (none in-flight) → kill", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));
		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		child.sendReady();
		const run = await child.nextRun();
		child.sendResult(run); // valid first response
		await p;
		child.sendResult(run); // replay — no in-flight request
		await flush();
		expect(child.killed).toBe(true);
		expect(manager.state).toBe("dead");
	});

	it("duplicate ready handshake → kill", async () => {
		const { child, p } = await inFlight();
		child.sendReady(); // second handshake
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
	});

	it("wrong-generation ready handshake → kill", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));
		const p = manager.run(INPUT, new AbortController().signal).catch((e) => e);
		const child = await harness.nextChild();
		child.sendReady(99); // forged generation in the handshake
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
	});

	it("a ready arriving after the first response → kill", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness));
		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		child.sendReady();
		const run = await child.nextRun();
		child.sendResult(run);
		await p;
		child.sendReady(); // post-response handshake is a violation
		await flush();
		expect(child.killed).toBe(true);
		expect(manager.state).toBe("dead");
	});

	it("a never-completing frame stream trips the aggregate cap → kill", async () => {
		const harness = makeHarness();
		const manager = track(makeManager(harness, { maxAggregateBytes: 4096 }));
		const p = manager.run(INPUT, new AbortController().signal).catch((e) => e);
		const child = await harness.nextChild();
		child.sendReady();
		await child.nextRun();
		// A header claiming a large (but under per-frame-cap) body, then bytes that
		// dribble in below the per-frame cap and never complete the frame → the
		// accumulated buffer crosses the aggregate cap before any frame parses.
		const header = Buffer.alloc(4);
		header.writeUInt32BE(1_000_000, 0);
		child.stdout.write(header);
		for (let i = 0; i < 10; i++) child.stdout.write(Buffer.alloc(900, 0x20));
		expect(await p).toBeInstanceOf(IpcIntegrityError);
		expect(child.killed).toBe(true);
	});
});

describe("PyodideSandbox — spawn posture", () => {
	it("spawns deno with the committed deny-belt, an asset-dir-scoped allow-read, and a scrubbed env", async () => {
		const calls: { cmd: string; args: readonly string[]; opts: SpawnOptions }[] = [];
		const harness = makeHarness();
		const recordingSpawn: typeof harness.spawnFn = (cmd, args, opts) => {
			calls.push({ cmd, args, opts });
			return harness.spawnFn(cmd, args, opts);
		};
		const manager = track(
			new PyodideSandbox({
				assetDir: "/vendor/pyodide",
				denoBin: "/vendor/deno/deno",
				runnerPath: "/dist/pyodide-runner/runner.ts",
				spawnFn: recordingSpawn,
				randomRequestId: () => "req-x",
			}),
		);

		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		child.sendReady();
		child.sendResult(await child.nextRun());
		await p;

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.cmd).toBe("/vendor/deno/deno");
		// committed flags verbatim, then the only granted capability, then runner + argv.
		expect(call.args).toEqual([
			"run",
			...COMMITTED_FLAGS,
			"--allow-read=/vendor/pyodide",
			"/dist/pyodide-runner/runner.ts",
			"/vendor/pyodide",
			"1",
		]);
		// Scrubbed env: ONLY the update-check suppressor — no AUTH_SECRET/DATABASE_URL.
		expect(call.opts.env).toEqual({ DENO_NO_UPDATE_CHECK: "1" });
		expect(call.opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
	});
});

describe("PyodideSandbox — dispose", () => {
	it("dispose kills the child and rejects an in-flight run; further runs reject", async () => {
		const harness = makeHarness();
		const manager = new PyodideSandbox({
			assetDir: "/a",
			denoBin: "/d",
			runnerPath: "/r",
			spawnFn: harness.spawnFn,
			randomRequestId: () => "req-d",
		});
		const p = manager.run(INPUT, new AbortController().signal);
		const child = await harness.nextChild();
		child.sendReady();
		await child.nextRun();

		await manager.dispose();
		await expect(p).rejects.toBeInstanceOf(PyodideDisposedError);
		expect(child.killed).toBe(true);
		await expect(manager.run(INPUT, new AbortController().signal)).rejects.toBeInstanceOf(PyodideDisposedError);
	});
});
