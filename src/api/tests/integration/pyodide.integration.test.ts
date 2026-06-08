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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
	const cleanup: string[] = [];

	beforeAll(() => {
		process.env.PYODIDE_ASSET_DIR = ASSET_DIR;
		process.env.DENO_BIN_PATH = DENO_BIN;
		sm = new SessionManager({ tenantConfig: loadTenantConfig() });
	});

	afterAll(async () => {
		await sm.shutdown({ drainTimeoutMs: 5_000 }).catch(() => {});
		for (const id of cleanup) {
			try {
				await destroySandbox("postgres", id);
			} catch {
				/* ignore */
			}
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
});
