// Spike S2 — IPC integrity (gates Phase 3/4).
//
// Confirms the COMMITTED design (design.md Decision 1) — it does NOT re-choose a
// transport. It models the ACTUAL post-S1 runner realm (which installs Node-compat
// globals `require`/`__dirname`/`__filename` so Emscripten/Pyodide can load) and
// proves what the design's IPC integrity actually rests on.
//
// THREE things are proven/characterised in a real Deno realm under the deny-belt:
//
//   (A) Realm lockdown — necessary but NOT sufficient. Capturing the stdout writer
//       into a closure and deleting Deno/console/require/__dirname/__filename from
//       globalThis blocks the EASY write primitives. But `import("node:fs")` is
//       SYNTAX (undeletable), node: builtins are not gated by --deny-import/--no-npm,
//       and --deny-write does NOT block writes to the already-open stdout fd — so
//       untrusted JS CAN still `(await import("node:fs")).writeSync(1, bytes)`.
//       => Lockdown is hardening; it cannot contain raw stdout writes.
//
//   (B) Forge-resistance is the REAL guarantee. Every frame carries mandatory
//       integrity fields — random requestId, monotonic seq, child-generation id —
//       held only by Node and the runner's closure, NEVER exposed to untrusted code.
//       So an attacker who CAN write bytes to stdout still cannot produce a frame
//       Node accepts: it must GUESS the secret fields, and the validator KILLS the
//       child on any mismatch. It also cannot read its own stdout, so it cannot
//       replay a real frame. Node-side validation is LOAD-BEARING, not optional.
//
//   (C) Frame validation rejects forged / interleaved / replayed / stale-generation
//       per-request frames AND enforces the one-time `ready` handshake (no
//       requestId/seq; valid once, before any response, current generation only;
//       duplicate / post-response / wrong-generation all kill the child).
//
// Run under the committed deny-belt (no --allow-read needed; node:fs import + the
// stdout write below need NO permission — that is the whole point of finding A):
//   deno run --no-prompt --deny-net --deny-run --deny-write --deny-env --deny-ffi \
//     --deny-sys --deny-import --no-remote --no-npm --cached-only --no-config s2-ipc.ts
//
// Exit 0 only if every committed-design assertion passes; prints "PASS <case>" per
// case and "NOTE <finding>" for the lockdown-insufficiency characterisation.

// deno-lint-ignore-file no-explicit-any
import { createRequire } from "node:module";

const enc = new TextEncoder();
const MAX_FRAME_BYTES = 4096; // wire-size cap for the spike

// --- Capture the legitimate writer BEFORE lockdown --------------------------
// A synchronous writer is captured into a module-local closure. This is the ONLY
// sanctioned path to the real stdout and is NOT reachable from globalThis.
const _denoRef = (globalThis as any).Deno;
const writeSync: (b: Uint8Array) => number = _denoRef.stdout.writeSync.bind(_denoRef.stdout);
function out(line: string): void {
	writeSync(enc.encode(`${line}\n`));
}

// --- Length-prefixed JSON framing -------------------------------------------
function encodeFrame(obj: unknown): Uint8Array {
	const json = enc.encode(JSON.stringify(obj));
	const buf = new Uint8Array(4 + json.byteLength);
	new DataView(buf.buffer).setUint32(0, json.byteLength, false); // big-endian length prefix
	buf.set(json, 4);
	return buf;
}

// `ready` handshake frame: { type, generation } — NO requestId/seq (plan.md:357).
interface ReadyFrame {
	type: "ready";
	generation: number;
}
// Per-request response frame: result|error with the secret integrity fields.
interface ResponseFrame {
	type: "result" | "error";
	requestId: string;
	seq: number;
	generation: number;
	payload?: string; // base64 stand-in for stdout/created-files bytes
}

type Verdict = { ok: true } | { kill: string };

// Parent-side validator for one child generation. Mirrors the production
// "kill the child on ANY anomaly" rule: any non-ok verdict ⇒ kill the child.
class SessionValidator {
	#lastSeq = -1;
	#readySeen = false;
	#anyResponse = false;
	readonly #responded = new Set<string>();
	readonly #generation: number;
	readonly #inflight: ReadonlySet<string>; // requestIds Node has actually issued

	constructor(generation: number, inflight: Iterable<string>) {
		this.#generation = generation;
		this.#inflight = new Set(inflight);
	}

	// One-time pre-run handshake. Valid once, before any response, current generation.
	acceptReady(wire: Uint8Array, f: ReadyFrame): Verdict {
		if (wire.byteLength > MAX_FRAME_BYTES) return { kill: "oversized" };
		if (f.type !== "ready") return { kill: "not-a-ready-frame" };
		if (f.generation !== this.#generation) return { kill: "wrong-generation-ready" };
		if (this.#anyResponse) return { kill: "ready-after-response" };
		if (this.#readySeen) return { kill: "duplicate-ready" };
		this.#readySeen = true;
		return { ok: true };
	}

	// Per-request response. Exactly one result|error per issued requestId, in
	// strictly-increasing seq, current generation only.
	acceptResponse(wire: Uint8Array, f: ResponseFrame): Verdict {
		if (wire.byteLength > MAX_FRAME_BYTES) return { kill: "oversized" };
		if (f.generation !== this.#generation) return { kill: "stale-generation" };
		if (f.type !== "result" && f.type !== "error") return { kill: "forged-type" };
		if (!this.#inflight.has(f.requestId)) return { kill: "forged-requestId" };
		if (this.#responded.has(f.requestId)) return { kill: "duplicate-response" };
		if (typeof f.seq !== "number" || f.seq <= this.#lastSeq) return { kill: "out-of-sequence" };
		this.#lastSeq = f.seq;
		this.#responded.add(f.requestId);
		this.#anyResponse = true;
		return { ok: true };
	}
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) out(`PASS ${label}`);
	else {
		failures++;
		out(`FAIL ${label} ${detail}`);
	}
}

// ============================================================================
// Model the ACTUAL runner realm: install the Node-compat globals S1 requires,
// then lock down. (This is the realm untrusted code actually sees in prod.)
// ============================================================================
const g = globalThis as any;
g.require = createRequire(import.meta.url);
g.__dirname = "/spike";
g.__filename = "/spike/runner.ts";

// Closure-held control writer; never placed on globalThis.
const capturedWriter = { emit: (f: Uint8Array) => writeSync(f) };
void capturedWriter;

// Lockdown: delete EVERY deletable host/Node-compat write primitive.
delete g.Deno;
delete g.console;
delete g.require;
delete g.__dirname;
delete g.__filename;

// ============================================================================
// (A) Realm lockdown — deletable primitives blocked; import("node:fs") is NOT.
// ============================================================================
// Untrusted adversary: an async `new Function` body sees ONLY globalThis + import().
const adversary = new Function(`return (async () => {
	const r = {};
	try { Deno.stdout.write(new Uint8Array([1])); r.deno = "SUCCEEDED"; } catch { r.deno = "blocked"; }
	try { console.log("x"); r.console = "SUCCEEDED"; } catch { r.console = "blocked"; }
	try { require("fs"); r.require = "SUCCEEDED"; } catch { r.require = "blocked"; }
	try {
		const fs = await import("node:fs");
		// Write a single harmless byte to fd 1 to detect whether this path reaches stdout.
		fs.writeSync(1, new Uint8Array([0x20])); // a space; benign on the wire
		r.importFsWrite = "SUCCEEDED";
	} catch (e) { r.importFsWrite = "blocked:" + (e.code || e.name); }
	return r;
})();`) as () => Promise<Record<string, string>>;

const a = await adversary();
// The deletable primitives MUST be blocked.
check(
	`realm-lockdown blocks deletable primitives [Deno=${a.deno},console=${a.console},require=${a.require}]`,
	a.deno === "blocked" && a.console === "blocked" && a.require === "blocked",
	JSON.stringify(a),
);
// The import("node:fs") stdout write is EXPECTED to succeed — this is the finding.
if (a.importFsWrite === "SUCCEEDED") {
	out(`NOTE lockdown is NOT sufficient: import("node:fs").writeSync(1,…) reaches stdout under the deny-belt`);
	out(`NOTE => Node-side frame validation with secret generation/requestId is LOAD-BEARING (design.md D1)`);
} else {
	out(`NOTE import("node:fs") stdout write was ${a.importFsWrite} (Deno behaviour differs from spike host)`);
}

// ============================================================================
// (B) Forge-resistance: an attacker WITH stdout access still cannot pass Node's
// validator, because it must guess the secret generation/requestId.
// ============================================================================
const GEN = 7;
const INFLIGHT = ["req-A", "req-B", "req-X"]; // requestIds Node actually issued
{
	const v = new SessionValidator(GEN, INFLIGHT);
	// Attacker writes a "result" with GUESSED secrets (it cannot read the real ones).
	const guessed: ResponseFrame = { type: "result", requestId: "req-GUESS", seq: 0, generation: 999 };
	const verdict = v.acceptResponse(encodeFrame(guessed), guessed);
	check("forge-resistance: guessed-secret frame rejected", "kill" in verdict, JSON.stringify(verdict));
}

// ============================================================================
// (C1) One-time `ready` handshake — valid once / duplicate / post-response /
// wrong-generation.
// ============================================================================
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const ready: ReadyFrame = { type: "ready", generation: GEN };
	check("ready handshake accepted once", "ok" in v.acceptReady(encodeFrame(ready), ready));
	// duplicate ready
	check("duplicate-ready rejected", "kill" in v.acceptReady(encodeFrame(ready), ready));
}
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const resp: ResponseFrame = { type: "result", requestId: "req-A", seq: 0, generation: GEN };
	v.acceptResponse(encodeFrame(resp), resp); // first response
	const lateReady: ReadyFrame = { type: "ready", generation: GEN };
	check("ready-after-response rejected", "kill" in v.acceptReady(encodeFrame(lateReady), lateReady));
}
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const staleReady: ReadyFrame = { type: "ready", generation: GEN - 1 };
	check("wrong-generation-ready rejected", "kill" in v.acceptReady(encodeFrame(staleReady), staleReady));
}

// ============================================================================
// (C2) Per-request frames — forged / interleave / replay / stale-generation /
// oversized.  (Required gate labels — keep exact text.)
// ============================================================================
// baseline: ready then a valid result accepted.
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const ready: ReadyFrame = { type: "ready", generation: GEN };
	const r: ResponseFrame = { type: "result", requestId: "req-A", seq: 1, generation: GEN };
	check(
		"baseline ready + result accepted",
		"ok" in v.acceptReady(encodeFrame(ready), ready) && "ok" in v.acceptResponse(encodeFrame(r), r),
	);
}
// forged: a result for a requestId Node never issued.
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const forged: ResponseFrame = { type: "result", requestId: "req-NEVER", seq: 0, generation: GEN };
	check("forged-frame rejected", "kill" in v.acceptResponse(encodeFrame(forged), forged));
}
// interleave: after accepting seq=5 (req-A), an earlier-numbered seq=3 (req-B).
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const a5: ResponseFrame = { type: "result", requestId: "req-A", seq: 5, generation: GEN };
	v.acceptResponse(encodeFrame(a5), a5);
	const b3: ResponseFrame = { type: "result", requestId: "req-B", seq: 3, generation: GEN };
	check("interleave rejected", "kill" in v.acceptResponse(encodeFrame(b3), b3));
}
// replay: a second response for an already-responded requestId (higher seq, so
// only the per-request single-response rule catches it).
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const x2: ResponseFrame = { type: "result", requestId: "req-X", seq: 2, generation: GEN };
	v.acceptResponse(encodeFrame(x2), x2);
	const x4: ResponseFrame = { type: "result", requestId: "req-X", seq: 4, generation: GEN };
	check("replay rejected", "kill" in v.acceptResponse(encodeFrame(x4), x4));
}
// stale-generation: a response from a killed/old child generation.
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const stale: ResponseFrame = { type: "result", requestId: "req-A", seq: 0, generation: GEN - 1 };
	check("stale-generation rejected", "kill" in v.acceptResponse(encodeFrame(stale), stale));
}
// oversized: a frame above the wire-size cap.
{
	const v = new SessionValidator(GEN, INFLIGHT);
	const big: ResponseFrame = { type: "result", requestId: "req-A", seq: 0, generation: GEN, payload: "A".repeat(MAX_FRAME_BYTES) };
	check("oversized rejected", "kill" in v.acceptResponse(encodeFrame(big), big));
}

if (failures > 0) {
	out(`S2 FAIL: ${failures} case(s) failed`);
	throw new Error(`S2 FAIL: ${failures} case(s) failed`); // Deno exits 1 on uncaught throw
}
out("S2 ALL PASS");
