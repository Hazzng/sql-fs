/**
 * Integration test for the `pyodide` runtime — the issue's CORE requirement.
 *
 * Runs the REAL stack: a Postgres-backed SqlFs session, the custom `python3`
 * command, the Node PyodideSandbox manager, and a real OS-isolated Deno
 * subprocess loading Pyodide offline (numpy/pandas/scipy/openpyxl). Proves a
 * `python3 analyze.py` that imports pandas, reads a CSV, and writes `out.xlsx`
 * drains the file back into SqlFs where the files API can retrieve it.
 *
 * Skipped unless DATABASE_URL is set AND the vendored Deno + Pyodide assets are
 * present (they are git-ignored; produced by scripts/fetch-pyodide-assets.mjs).
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { destroySandbox } from "../../../sql-fs/index.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";

const TENANT = "default";
const PYODIDE = { pythonRuntime: "pyodide", javascript: false, network: false } as const;

const ASSET_DIR = fileURLToPath(new URL("../../../../vendor/pyodide", import.meta.url));
const DENO_BIN = fileURLToPath(new URL("../../../../vendor/deno/deno", import.meta.url));
const ASSETS_PRESENT = existsSync(ASSET_DIR) && existsSync(DENO_BIN);

const SKIP = !process.env.DATABASE_URL || !ASSETS_PRESENT;

// Cold start = Deno spawn + Pyodide init + numpy/pandas/scipy/openpyxl load — several seconds.
const COLD = 120_000;

describe.skipIf(SKIP)("pyodide runtime — end-to-end (real Deno + Pyodide)", () => {
	let sm: SessionManager;
	let cleanup: string[] = [];
	const savedEnv = new Map<string, string | undefined>();

	beforeAll(() => {
		for (const k of ["PYODIDE_ASSET_DIR", "DENO_BIN_PATH"]) savedEnv.set(k, process.env[k]);
		process.env.PYODIDE_ASSET_DIR = ASSET_DIR;
		process.env.DENO_BIN_PATH = DENO_BIN;
		sm = new SessionManager({ tenantConfig: loadTenantConfig() });
	});

	// Clean up each test's sandbox (session + Deno child + DB rows) per test, rather
	// than letting them accumulate until the final shutdown().
	afterEach(async () => {
		for (const id of cleanup) {
			await sm.destroy(TENANT, id).catch(() => {});
			await destroySandbox("postgres", id).catch(() => {});
		}
		cleanup = [];
	});

	afterAll(async () => {
		await sm.shutdown({ drainTimeoutMs: 5_000 }).catch(() => {});
		for (const [k, v] of savedEnv) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
	});

	it(
		"runs python3 analyze.py (pandas → out.xlsx) and the file is retrievable",
		async () => {
			const id = `pyo-e2e-${Date.now()}`;
			cleanup.push(id);
			const session = await sm.getOrCreate(TENANT, id, PYODIDE, "owner");
			const cwd = session.cwd;
			await session.fs.mkdir(cwd, { recursive: true });
			await session.fs.writeFile(`${cwd}/data.csv`, "a,b\n1,2\n3,4\n5,6\n");
			// Uses a `__main__` guard + `__file__` so this also proves CPython
			// script-file parity (the runner seeds __name__/__file__ in the namespace).
			await session.fs.writeFile(
				`${cwd}/analyze.py`,
				[
					"import pandas as pd",
					"def main():",
					'    df = pd.read_csv("data.csv")',
					'    df["c"] = df["a"] + df["b"]',
					'    df.to_excel("out.xlsx", index=False, engine="openpyxl")',
					'    print("rows", len(df), "file", __file__)',
					'if __name__ == "__main__":',
					"    main()",
				].join("\n"),
			);

			const result = await sm.execWithRuntimeThrottle(session, "python3 analyze.py");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("rows 3");
			expect(result.stdout).toContain("file analyze.py"); // __file__ == argv[0]

			// Retrievable via the files-API data path, and a valid .xlsx (PK zip).
			const bytes = await session.fs.readFileBuffer(`${cwd}/out.xlsx`);
			expect(bytes.byteLength).toBeGreaterThan(0);
			expect(bytes[0]).toBe(0x50); // 'P'
			expect(bytes[1]).toBe(0x4b); // 'K'
		},
		COLD,
	);

	it(
		"-c one-liner reports the pandas version and exit 0",
		async () => {
			const id = `pyo-c-${Date.now()}`;
			cleanup.push(id);
			const session = await sm.getOrCreate(TENANT, id, PYODIDE, "owner");
			const result = await sm.execWithRuntimeThrottle(session, 'python3 -c "import pandas; print(pandas.__version__)"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);
		},
		COLD,
	);

	it(
		"a read-only exec that mutates the filesystem is rejected with EREADONLY_VIOLATION",
		async () => {
			const id = `pyo-ro-${Date.now()}`;
			cleanup.push(id);
			const session = await sm.getOrCreate(TENANT, id, PYODIDE, "owner");
			const cwd = session.cwd;
			await session.fs.mkdir(cwd, { recursive: true });
			await session.fs.writeFile(`${cwd}/writer.py`, 'open("evil.txt", "w").write("nope")\nprint("wrote")');

			await expect(
				sm.withSessionRead(TENANT, id, (s) => sm.execWithRuntimeThrottle(s, "python3 writer.py"), PYODIDE),
			).rejects.toMatchObject({ code: "EREADONLY_VIOLATION" });

			// The mutation must NOT have leaked to the store.
			expect(await session.fs.exists(`${cwd}/evil.txt`)).toBe(false);
		},
		COLD,
	);

	it(
		"injects exec env into os.environ and does not leak it across runs (reviews #6/#3)",
		async () => {
			const id = `pyo-env-${Date.now()}`;
			cleanup.push(id);
			const session = await sm.getOrCreate(TENANT, id, PYODIDE, "owner");
			// #6: a bash-exported var is visible in Python's os.environ for the run; the
			// script also sets a NEW os.environ key to probe cross-run leakage.
			const r1 = await sm.execWithRuntimeThrottle(
				session,
				`export FOO=barvalue; python3 -c "import os; print('FOO=' + os.environ.get('FOO','none')); os.environ['LEAK']='run1'"`,
			);
			expect(r1.exitCode).toBe(0);
			expect(r1.stdout).toContain("FOO=barvalue");

			// #3: on the SAME warm child, neither the injected FOO nor the script-set
			// LEAK may survive into the next run (env is strictly per-execution).
			const r2 = await sm.execWithRuntimeThrottle(
				session,
				`python3 -c "import os; print('LEAK=' + os.environ.get('LEAK','clean') + ' FOO=' + os.environ.get('FOO','clean'))"`,
			);
			expect(r2.exitCode).toBe(0);
			expect(r2.stdout).toContain("LEAK=clean");
			expect(r2.stdout).toContain("FOO=clean");
		},
		COLD,
	);

	it(
		"a file script can import a sibling module from its own directory (sys.path, review #1)",
		async () => {
			const id = `pyo-syspath-${Date.now()}`;
			cleanup.push(id);
			const session = await sm.getOrCreate(TENANT, id, PYODIDE, "owner");
			const cwd = session.cwd;
			await session.fs.mkdir(`${cwd}/pkg`, { recursive: true });
			await session.fs.writeFile(`${cwd}/pkg/helper.py`, "VALUE = 42\n");
			await session.fs.writeFile(`${cwd}/pkg/main.py`, "import helper\nprint('val', helper.VALUE)\n");
			// Sibling import only resolves if the script's dir (pkg/) is on sys.path[0].
			const r = await sm.execWithRuntimeThrottle(session, "python3 pkg/main.py");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("val 42");
		},
		COLD,
	);

	it(
		"replaces a file with a directory and drains the replacement (file↔dir baseline, review #2)",
		async () => {
			const id = `pyo-replace-${Date.now()}`;
			cleanup.push(id);
			const session = await sm.getOrCreate(TENANT, id, PYODIDE, "owner");
			const cwd = session.cwd;
			await session.fs.mkdir(cwd, { recursive: true });
			await session.fs.writeFile(`${cwd}/x`, "i am a file");
			await session.fs.writeFile(
				`${cwd}/replace.py`,
				[
					"import os",
					"os.remove('x')",
					"os.mkdir('x')",
					"open('x/inside.txt','w').write('hi')",
					"print('replaced')",
				].join("\n"),
			);
			const r = await sm.execWithRuntimeThrottle(session, "python3 replace.py");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("replaced");
			// The file→dir replacement must persist to SqlFs (was invisible before #2).
			expect((await session.fs.stat(`${cwd}/x`)).isDirectory).toBe(true);
			expect(await session.fs.readFile(`${cwd}/x/inside.txt`, "utf8")).toBe("hi");
		},
		COLD,
	);
});
