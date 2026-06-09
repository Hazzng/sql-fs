// Spike S1 — Pyodide-on-Deno, fully offline, under the committed deny-belt.
//
// Gates Phase 3. Run via s1-pyodide-deno.sh, which spawns Deno with:
//   --no-prompt --deny-net --deny-run --deny-write --deny-env --deny-ffi
//   --deny-sys --deny-import --no-remote --no-npm --cached-only --no-config
//   --allow-read=<assetDir>
//
// The asset dir is passed as ARGV (Deno.args[0]) — NOT via Deno.env, which
// --deny-env blocks. DENO_NO_UPDATE_CHECK=1 is set in the parent spawn env and
// is read by the Deno runtime itself (not via Deno.env).
//
// Success criterion: load Pyodide + numpy/pandas/scipy/openpyxl from local disk,
// run a pandas -> openpyxl .xlsx round-trip, and print the round-trip byte
// length — all with ZERO network (proven by --deny-net: any network attempt
// would throw a Deno permission error and fail the run).

import { createRequire } from "node:module";

const assetDir = Deno.args[0];
if (!assetDir) {
	console.error("S1 FAIL: asset dir not provided as argv[0]");
	Deno.exit(2);
}

// indexURL must end with a trailing slash; Pyodide resolves pyodide.asm.wasm,
// python_stdlib.zip, package wheels, and pyodide-lock.json relative to it.
const indexURL = assetDir.endsWith("/") ? assetDir : `${assetDir}/`;
const assetRoot = indexURL.replace(/\/$/, ""); // dir, no trailing slash

// --- Deno-runs-Pyodide compatibility shims (install BEFORE importing Pyodide) -
// Deno exposes `process.versions.node`, so Pyodide's loader detects IN_NODE and
// takes the Node-fs path (it has NO Deno.readFile branch — it would otherwise
// need network `fetch`). That path works offline, but Emscripten's pyodide.asm.js
// is generated for CommonJS Node and uses BARE `require(...)` / `__dirname` /
// `__filename`, none of which exist in a Deno ESM module. Provide them as globals
// (bare identifiers fall through to globalThis) so Emscripten resolves them:
//   - require -> Deno node-compat builtins (fs/path/crypto/...)
//   - __dirname/__filename -> the asset dir, where pyodide.asm.wasm lives.
// Pyodide's own initNodeModules returns early (its bundler require-shim is
// defined), so the npm `import("ws")` line is never reached — no --no-npm break.
// deno-lint-ignore no-explicit-any
const g = globalThis as any;
g.require = createRequire(import.meta.url);
g.__dirname = assetRoot;
g.__filename = `${assetRoot}/pyodide.asm.js`;

function log(msg: string): void {
	console.error(`[s1] ${msg}`); // diagnostics on stderr; the asserted result goes to stdout
}

try {
	log(`assetDir=${assetDir}`);
	log("importing pyodide.mjs from local disk…");
	// Local dynamic import under --allow-read. --deny-import blocks REMOTE imports
	// only; a local file:// import within the read scope is permitted.
	const pyodideModule = await import(`file://${indexURL}pyodide.mjs`);
	const loadPyodide = pyodideModule.loadPyodide;

	log("loadPyodide({ indexURL, lockFileURL }) — offline…");
	const pyodide = await loadPyodide({
		indexURL,
		lockFileURL: `${indexURL}pyodide-lock.json`,
		// Keep stdout clean — Pyodide's own banner/print goes to our handlers.
		stdout: (s: string) => log(`py.stdout: ${s}`),
		stderr: (s: string) => log(`py.stderr: ${s}`),
	});
	log(`Pyodide ${pyodide.version} loaded`);

	// numpy/pandas/scipy ship in the pyodide distribution → load by name.
	log("loadPackage([numpy, pandas, scipy]) — from local distribution wheels…");
	await pyodide.loadPackage(["numpy", "pandas", "scipy"]);

	// openpyxl + et_xmlfile are NOT in the distribution; load the vendored
	// pure-python wheels by local file:// URL (argv[1..]). loadPackage reads them
	// via node:fs under --allow-read — no network, no PyPI.
	const wheelArgs = Deno.args.slice(1);
	if (wheelArgs.length === 0) {
		console.error("S1 FAIL: no vendored wheels passed (expected et_xmlfile + openpyxl)");
		Deno.exit(2);
	}
	const wheelUrls = wheelArgs.map((w) => `file://${indexURL}${w}`);
	log(`loadPackage(vendored wheels) — ${wheelArgs.join(", ")}…`);
	await pyodide.loadPackage(wheelUrls);
	log("packages loaded");

	// pandas -> openpyxl round-trip entirely in-memory (no FS write needed for the spike).
	const roundTrip = `
import io
import pandas as pd
import numpy as np
import scipy  # prove scipy imports

df = pd.DataFrame({"a": np.arange(3), "b": ["x", "y", "z"]})
buf = io.BytesIO()
df.to_excel(buf, index=False, engine="openpyxl")
xlsx_bytes = buf.getvalue()

# Read it back and assert structural equality.
df2 = pd.read_excel(io.BytesIO(xlsx_bytes), engine="openpyxl")
assert list(df2.columns) == ["a", "b"], df2.columns
assert df2.shape == (3, 2), df2.shape
assert df2["b"].tolist() == ["x", "y", "z"], df2["b"].tolist()

len(xlsx_bytes)
`;
	const byteLen = await pyodide.runPythonAsync(roundTrip);

	if (typeof byteLen !== "number" || byteLen <= 0) {
		console.error(`S1 FAIL: round-trip produced no bytes (got ${byteLen})`);
		Deno.exit(1);
	}

	// The single asserted result line on stdout.
	console.log(`S1 PASS pyodide=${pyodide.version} roundtrip_xlsx_bytes=${byteLen}`);
	Deno.exit(0);
} catch (err) {
	console.error("S1 FAIL: exception during offline Pyodide run:");
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	Deno.exit(1);
}
