/**
 * Frame-forgery suite — proves the load-bearing IPC integrity control (spike S2
 * finding A) under a REAL Deno child running untrusted Python.
 *
 * Threat model (S2 finding A): realm lockdown is NOT stdout containment — escaped
 * JS CAN write arbitrary bytes to the stdout pipe via
 * `(await import("node:fs")).writeSync(1, …)` (node: builtins aren't on the
 * deny-belt; `--deny-write` doesn't gate the already-open fd). The invariant is
 * therefore NARROWER: escaped code cannot produce an _accepted_ control frame,
 * because `requestId`/`seq`/`generation` are unguessable secrets never exposed to
 * untrusted Python, and a process cannot read its own stdout to replay a real
 * frame. Any forgery attempt → the Node side KILLS the child and DRAINS NOTHING
 * (self-DoS of that one session, never a drain of forged files).
 *
 * The exhaustive `validateInbound` matrix (every result/ready variant, interleave,
 * replay, size caps) is unit-tested in Phase 4 (`ipc.test.ts` 29 + `manager.test.ts`
 * 22) against the fake child, which models the identical validation path. This
 * suite proves the REALISTIC attack — a frame injected via the real
 * `node:fs.writeSync(1, …)` escape hatch — actually reaches Node and is rejected.
 */

import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunResponse } from "../../../../pyodide-runner/protocol.js";
import { PyodideDrainError, drain } from "../../../commands/pyodide-command.js";
import { SessionManager } from "../../../session-manager.js";

const TENANT = "default";
const PYODIDE = { pythonRuntime: "pyodide", javascript: false, network: false } as const;

const ASSET_DIR = fileURLToPath(new URL("../../../../../vendor/pyodide", import.meta.url));
const DENO_BIN = fileURLToPath(new URL("../../../../../vendor/deno/deno", import.meta.url));
const ASSETS_PRESENT = existsSync(ASSET_DIR) && existsSync(DENO_BIN);

const COLD = 120_000;

/**
 * A Python program that creates `evil.txt` in cwd (so a LEGIT result frame WOULD
 * drain it — proving the kill blocks the drain) and then injects `frameJs` (a JS
 * expression producing the forged frame bytes) onto the raw stdout fd via
 * `node:fs.writeSync(1, …)`.
 */
function forgeScript(frameJs: string): string {
	return [
		"from pyodide.code import run_js",
		'with open("evil.txt", "w") as f:',
		'    f.write("pwned")',
		"res = run_js(r'''",
		"(async () => {",
		'  const fs = await import("node:fs");',
		`  const buf = ${frameJs};`,
		"  fs.writeSync(1, buf);",
		'  return "INJECTED";',
		"})()",
		"''')",
		"print(await res)",
	].join("\n");
}

/** JS that length-prefixes a JSON object literal into a complete frame Uint8Array. */
function frameOf(jsonExpr: string): string {
	return [
		"(() => {",
		`  const enc = new TextEncoder().encode(JSON.stringify(${jsonExpr}));`,
		"  const b = new Uint8Array(4 + enc.byteLength);",
		"  new DataView(b.buffer).setUint32(0, enc.byteLength, false);",
		"  b.set(enc, 4);",
		"  return b;",
		"})()",
	].join("\n");
}

describe.skipIf(!ASSETS_PRESENT)("pyodide frame-forgery suite (real Deno child)", () => {
	let sm: SessionManager;
	let session: Awaited<ReturnType<SessionManager["getOrCreate"]>>;

	beforeAll(() => {
		process.env.PYODIDE_ASSET_DIR = ASSET_DIR;
		process.env.DENO_BIN_PATH = DENO_BIN;
		sm = new SessionManager({ createFs: (): Promise<IFileSystem> => Promise.resolve(new InMemoryFs()) });
	});

	afterAll(async () => {
		await sm.shutdown({ drainTimeoutMs: 5_000 }).catch(() => {});
	});

	beforeEach(async () => {
		// Fresh session per test — each forgery kills the child; a fresh session keeps
		// the assertions independent (each cold-starts its own child on first exec).
		session = await sm.getOrCreate(TENANT, `forge-${Date.now()}-${Math.random().toString(36).slice(2)}`, PYODIDE);
		await session.fs.mkdir(session.cwd, { recursive: true });
	});

	/**
	 * Run a forge script. The forged frame is rejected by the Node validator, which
	 * KILLS the child; just-bash normalizes the resulting command-handler rejection
	 * into a non-zero {@link ExecResult} carrying the integrity error in stderr (it
	 * does NOT propagate as a thrown rejection for a custom command). Returns that
	 * result so the test asserts the failure + that nothing drained.
	 */
	async function runForge(name: string, frameJs: string): Promise<{ exitCode: number; stderr: string }> {
		await session.fs.writeFile(`${session.cwd}/${name}`, forgeScript(frameJs));
		const r = await sm.execWithRuntimeThrottle(session, `python3 ${name}`);
		return { exitCode: r.exitCode, stderr: r.stderr };
	}

	it(
		"a forged result frame (wrong requestId) injected via node:fs.writeSync kills the child and drains nothing",
		async () => {
			const frame = frameOf(
				'{type:"result",requestId:"forged-by-attacker",seq:1,generation:1,stdout:"",stderr:"",exitCode:0,created:[],modified:[],deleted:[]}',
			);
			const r = await runForge("forge.py", frame);
			// The forged frame is rejected (unguessable requestId) → kill-the-child →
			// the exec fails with the integrity error (never an accepted forged frame).
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toContain("EIPC_INTEGRITY");
			// And NOTHING drained — evil.txt existed in MEMFS but the legit result that
			// would have carried it was never accepted (child killed).
			expect(await session.fs.exists(`${session.cwd}/evil.txt`)).toBe(false);

			// Child was killed → a clean exec on the same session cold-starts a fresh
			// generation and succeeds (proves the kill retired the old generation).
			const genAfterKill = session.pyodideSandbox?.generation ?? 0;
			const clean = await sm.execWithRuntimeThrottle(session, 'python3 -c "print(42)"');
			expect(clean.exitCode).toBe(0);
			expect(clean.stdout).toContain("42");
			expect(session.pyodideSandbox?.generation ?? 0).toBeGreaterThan(genAfterKill);
		},
		COLD,
	);

	it(
		"a forged result frame with a wrong generation is rejected and drains nothing",
		async () => {
			const frame = frameOf(
				'{type:"result",requestId:"forged",seq:1,generation:9999,stdout:"",stderr:"",exitCode:0,created:[],modified:[],deleted:[]}',
			);
			const r = await runForge("forge_gen.py", frame);
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toContain("EIPC_INTEGRITY");
			expect(await session.fs.exists(`${session.cwd}/evil.txt`)).toBe(false);
		},
		COLD,
	);

	it(
		"a forged ready handshake injected mid-run is rejected and drains nothing",
		async () => {
			// A `ready` is valid exactly once, before any response. One injected during
			// a run (after the startup handshake / while a request is pending) → kill.
			const frame = frameOf('{type:"ready",generation:1}');
			const r = await runForge("forge_ready.py", frame);
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toContain("EIPC_INTEGRITY");
			expect(await session.fs.exists(`${session.cwd}/evil.txt`)).toBe(false);
		},
		COLD,
	);

	it(
		"malformed (non-JSON) injected bytes are rejected and drain nothing",
		async () => {
			// 4-byte length prefix + garbage body → decodeFrames JSON.parse throws an
			// IpcIntegrityError → kill-the-child.
			const frame = [
				"(() => {",
				'  const body = new TextEncoder().encode("{not valid json");',
				"  const b = new Uint8Array(4 + body.byteLength);",
				"  new DataView(b.buffer).setUint32(0, body.byteLength, false);",
				"  b.set(body, 4);",
				"  return b;",
				"})()",
			].join("\n");
			const r = await runForge("forge_malformed.py", frame);
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toContain("EIPC_INTEGRITY");
			expect(await session.fs.exists(`${session.cwd}/evil.txt`)).toBe(false);
		},
		COLD,
	);
});

// Pure-function check (no Deno needed) — always runs. The drain layer independently
// re-validates every path stays under cwd, so even a frame that somehow carried an
// escaping path is rejected before any write.
describe("pyodide drain — path validation (defense-in-depth, no Deno)", () => {
	function resp(over: Partial<RunResponse>): RunResponse {
		return {
			type: "result",
			requestId: "x",
			seq: 1,
			generation: 1,
			stdout: "",
			stderr: "",
			exitCode: 0,
			created: [],
			modified: [],
			deleted: [],
			...over,
		};
	}
	const caps = { maxFileBytes: 1 << 20, maxTotalBytes: 1 << 20 };

	it("rejects a drained file resolved outside cwd and writes nothing", async () => {
		const fs = new InMemoryFs();
		await fs.mkdir("/home/user", { recursive: true });
		const malicious = resp({
			created: [{ path: "/etc/evil", kind: "file", mode: 0o644, data: Buffer.from("x").toString("base64") }],
		});
		await expect(drain(fs, "/home/user", malicious, caps)).rejects.toBeInstanceOf(PyodideDrainError);
		expect(await fs.exists("/etc/evil")).toBe(false);
	});

	it("rejects a drained path that escapes cwd via ..", async () => {
		const fs = new InMemoryFs();
		await fs.mkdir("/home/user", { recursive: true });
		const malicious = resp({
			created: [
				{ path: "/home/user/../../etc/evil", kind: "file", mode: 0o644, data: Buffer.from("x").toString("base64") },
			],
		});
		await expect(drain(fs, "/home/user", malicious, caps)).rejects.toBeInstanceOf(PyodideDrainError);
	});
});
