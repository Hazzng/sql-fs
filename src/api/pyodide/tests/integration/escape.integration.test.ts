/**
 * Adversarial escape suite — the security acceptance gate (design Open Risk: C1
 * reversal). Runs UNTRUSTED Python in the REAL OS-isolated Deno child and proves
 * each escape **fails closed**: capability denial (no secret read, no network, no
 * host-FS reach, no subprocess, no FFI), not merely a thrown error.
 *
 * Threat model (spike S2): the Deno child runs under the committed deny-belt
 * (`--deny-net --deny-run --deny-write --deny-env --deny-ffi --deny-sys
 * --deny-import --no-remote --no-npm --cached-only --no-config`) with
 * `--allow-read` scoped to the vendored asset dir only, and the runner deletes the
 * deletable host primitives (`Deno`/`console`/`require`/`__dirname`/`__filename`)
 * before any untrusted Python runs. A full Python→JS escape therefore lands
 * capability-less.
 *
 * No Postgres needed — these prove the Deno boundary, so an InMemoryFs session is
 * used and the suite skips only when the vendored Deno + Pyodide assets are absent.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "../../../session-manager.js";

const TENANT = "default";
const PYODIDE = { pythonRuntime: "pyodide", javascript: false, network: false } as const;

const ASSET_DIR = fileURLToPath(new URL("../../../../../vendor/pyodide", import.meta.url));
const DENO_BIN = fileURLToPath(new URL("../../../../../vendor/deno/deno", import.meta.url));
const ASSETS_PRESENT = existsSync(ASSET_DIR) && existsSync(DENO_BIN);

// A distinctive secret planted in the PARENT env. The manager scrubs the child
// env to only DENO_NO_UPDATE_CHECK, so the child must NEVER be able to read it.
const SECRET = "S3CR3T-do-not-leak-9b2f4e";

// Deno spawn + Pyodide init + numpy/pandas/scipy/openpyxl load — several seconds (cold).
const COLD = 120_000;

describe.skipIf(!ASSETS_PRESENT)("pyodide adversarial escape suite (real Deno child)", () => {
	let sm: SessionManager;
	let session: Awaited<ReturnType<SessionManager["getOrCreate"]>>;
	const savedEnv = new Map<string, string | undefined>();

	beforeAll(async () => {
		for (const k of ["PYODIDE_ASSET_DIR", "DENO_BIN_PATH", "AUTH_SECRET"]) savedEnv.set(k, process.env[k]);
		process.env.PYODIDE_ASSET_DIR = ASSET_DIR;
		process.env.DENO_BIN_PATH = DENO_BIN;
		process.env.AUTH_SECRET = SECRET; // planted in the parent — the child must not see it
		sm = new SessionManager({ createFs: (): Promise<IFileSystem> => Promise.resolve(new InMemoryFs()) });
		session = await sm.getOrCreate(TENANT, "escape", PYODIDE, "owner");
		await session.fs.mkdir(session.cwd, { recursive: true });
		// Warm the child once so the per-test cost is just the exec.
		await sm.execWithRuntimeThrottle(session, 'python3 -c "print(1)"');
	}, COLD);

	afterAll(async () => {
		await sm.shutdown({ drainTimeoutMs: 5_000 }).catch(() => {});
		// Restore every env var we set so this suite doesn't pollute later test files.
		for (const [k, v] of savedEnv) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
	});

	/** Write `code` to a script file and run it on the warm child. */
	async function runScript(name: string, code: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		await session.fs.writeFile(`${session.cwd}/${name}`, code);
		const r = await sm.execWithRuntimeThrottle(session, `python3 ${name}`);
		return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
	}

	it(
		"import js; js.process.env cannot read a host secret",
		async () => {
			const r = await runScript(
				"env.py",
				[
					"import js",
					"try:",
					"    v = js.process.env.AUTH_SECRET",
					'    print("ENV", repr(v))',
					"except Exception as e:",
					'    print("ENV_BLOCKED", type(e).__name__)',
				].join("\n"),
			);
			// Capability denial: the planted secret is unreachable (scrubbed child env).
			expect(r.stdout + r.stderr).not.toContain(SECRET);
		},
		COLD,
	);

	it(
		"js.fetch is denied (no network)",
		async () => {
			const r = await runScript(
				"net.py",
				[
					"from pyodide.code import run_js",
					'res = run_js("""',
					"(async () => {",
					'  try { await fetch("http://169.254.169.254/latest/meta-data/"); return "FETCHED"; }',
					'  catch (e) { return "BLOCKED:" + (e && e.name); }',
					"})()",
					'""")',
					'print("NET", await res)',
				].join("\n"),
			);
			expect(r.stdout).toContain("NET BLOCKED");
			expect(r.stdout).not.toContain("FETCHED");
		},
		COLD,
	);

	it(
		"pyodide.code.run_js cannot read the host filesystem",
		async () => {
			const r = await runScript(
				"runjs.py",
				[
					"from pyodide.code import run_js",
					'res = run_js("""',
					"(async () => {",
					"  try {",
					'    const fs = await import("node:fs");',
					'    return "READ:" + fs.readFileSync("/etc/passwd", "utf8").slice(0, 16);',
					'  } catch (e) { return "BLOCKED:" + (e && e.name); }',
					"})()",
					'""")',
					'print("RUNJS", await res)',
				].join("\n"),
			);
			// --allow-read is scoped to the asset dir → /etc/passwd is denied.
			expect(r.stdout).toContain("RUNJS BLOCKED");
			expect(r.stdout).not.toContain("READ:");
			expect(r.stdout).not.toContain("root:"); // no /etc/passwd content leaked
		},
		COLD,
	);

	it(
		"ctypes cannot load a host shared library (no FFI to the host)",
		async () => {
			const r = await runScript(
				"ffi.py",
				[
					"import ctypes",
					"try:",
					'    ctypes.CDLL("libc.so.6")',
					'    print("CDLL_OK")',
					"except Exception as e:",
					'    print("CDLL_BLOCKED", type(e).__name__)',
				].join("\n"),
			);
			// WASM Pyodide has no host dynamic linker; loading a host lib must fail.
			expect(r.stdout).toContain("CDLL_BLOCKED");
			expect(r.stdout).not.toContain("CDLL_OK");
		},
		COLD,
	);

	it(
		"import('node:child_process') cannot spawn a subprocess",
		async () => {
			const r = await runScript(
				"spawn.py",
				[
					"from pyodide.code import run_js",
					'res = run_js("""',
					"(async () => {",
					"  try {",
					'    const cp = await import("node:child_process");',
					'    return "SPAWNED:" + cp.execSync("id").toString();',
					'  } catch (e) { return "BLOCKED:" + (e && e.name); }',
					"})()",
					'""")',
					'print("SPAWN", await res)',
				].join("\n"),
			);
			expect(r.stdout).toContain("SPAWN BLOCKED");
			expect(r.stdout).not.toContain("SPAWNED:");
			expect(r.stdout).not.toContain("uid="); // no `id` output leaked
		},
		COLD,
	);

	it(
		"the full deny-belt blocks fs-write / spawn / env / net / remote-import / npm-import; Deno is deleted",
		async () => {
			const r = await runScript(
				"denybelt.py",
				[
					"from pyodide.code import run_js",
					'rep = run_js("""',
					"(async () => {",
					"  const out = {};",
					'  try { const fs = await import("node:fs"); fs.writeFileSync("/tmp/pwn","x"); out.fs_write="SUCCEEDED"; }',
					'  catch (e) { out.fs_write="BLOCKED:"+(e&&e.name); }',
					'  try { const cp = await import("node:child_process"); cp.execSync("id"); out.spawn="SUCCEEDED"; }',
					'  catch (e) { out.spawn="BLOCKED:"+(e&&e.name); }',
					'  try { const p = await import("node:process"); out.env = (p.env && p.env.AUTH_SECRET) ? ("LEAKED:"+p.env.AUTH_SECRET) : "EMPTY"; }',
					'  catch (e) { out.env="BLOCKED:"+(e&&e.name); }',
					'  try { await fetch("http://169.254.169.254/"); out.net="SUCCEEDED"; }',
					'  catch (e) { out.net="BLOCKED:"+(e&&e.name); }',
					'  try { await import("https://example.com/x.js"); out.remote="SUCCEEDED"; }',
					'  catch (e) { out.remote="BLOCKED:"+(e&&e.name); }',
					'  try { await import("npm:left-pad"); out.npm="SUCCEEDED"; }',
					'  catch (e) { out.npm="BLOCKED:"+(e&&e.name); }',
					"  out.deno = (typeof Deno);",
					"  return JSON.stringify(out);",
					"})()",
					'""")',
					'print("DENYBELT", await rep)',
				].join("\n"),
			);
			const line = r.stdout.split("\n").find((l) => l.startsWith("DENYBELT ")) ?? "";
			const report = JSON.parse(line.slice("DENYBELT ".length)) as Record<string, string>;
			expect(report.fs_write).toMatch(/^BLOCKED:/);
			expect(report.spawn).toMatch(/^BLOCKED:/);
			expect(report.env).not.toMatch(/^LEAKED:/); // either BLOCKED or EMPTY
			expect(report.net).toMatch(/^BLOCKED:/);
			expect(report.remote).toMatch(/^BLOCKED:/);
			expect(report.npm).toMatch(/^BLOCKED:/);
			expect(report.deno).toBe("undefined"); // realm-lockdown deleted Deno (FFI/Deno.* unreachable)
			expect(r.stdout).not.toContain(SECRET);
		},
		COLD,
	);

	it(
		"fresh globals: a variable set in one exec is not visible in the next (intra-session isolation)",
		async () => {
			const set = await runScript("set.py", '__leak = "carried"\nprint("SET")');
			expect(set.stdout).toContain("SET");
			const get = await runScript(
				"get.py",
				["try:", '    print("GOT", __leak)', "except NameError:", '    print("ISOLATED")'].join("\n"),
			);
			expect(get.stdout).toContain("ISOLATED");
			expect(get.stdout).not.toContain("carried");
		},
		COLD,
	);
});
