# S1 — Pyodide-on-Deno offline (gates Phase 3)

## GATE: ✅ PASS

`s1-pyodide-deno.sh` exits **0** and prints (the byte count varies ±1 between
runs — openpyxl embeds document created/modified timestamps in the `.xlsx`, so
the zip size is not bit-deterministic; the gate is a **non-zero** round-trip):

```
S1 PASS pyodide=0.29.4 roundtrip_xlsx_bytes=4970   # ~4969–4970
```

A Deno subprocess, under the **exact committed deny-belt**, loaded Pyodide from
local disk, loaded numpy/pandas/scipy + openpyxl/et_xmlfile from local wheels,
and ran a pandas → openpyxl `.xlsx` round-trip (write 4970 bytes → read back →
structural assertions) with **zero network**.

## Pinned versions validated (Phase 3 MUST pin exactly these)

| Component | Version | Source |
|---|---|---|
| Deno | **v2.8.2** (`aarch64-apple-darwin` locally; pick the matching Linux target in the image) | `dl.deno.land/release/v2.8.2/...` |
| Pyodide full distribution | **0.29.4** | `github.com/pyodide/pyodide/releases/download/0.29.4/pyodide-0.29.4.tar.bz2` (408 MB) |
| openpyxl | **3.1.5** (`openpyxl-3.1.5-py2.py3-none-any.whl`, pure-python) | PyPI files.pythonhosted.org |
| et_xmlfile | **2.0.0** (`et_xmlfile-2.0.0-py3-none-any.whl`, pure-python) | PyPI files.pythonhosted.org |

> The plan (Phase 3, `fetch-pyodide-assets.mjs`) says "pins versions in a constant
> at the top of the file" but names no specific patch. **No conflicting pin
> exists yet** — S1 is the source of truth: Phase 3 should adopt Deno **v2.8.2**
> and Pyodide **0.29.4**. (Pyodide 0.29.4 ships CPython 3.12; both wheels are
> `requires_python >=3.8`, compatible.)

## Zero-network proof

The run uses the full belt: `--no-prompt --deny-net --deny-run --deny-write
--deny-env --deny-ffi --deny-sys --deny-import --no-remote --no-npm
--cached-only --no-config --allow-read=<assetDir>`. Any network attempt by
Pyodide would throw a Deno permission error and fail the run. **Success under
`--deny-net` is the proof.** The only network is in the BUILD step (downloading
Deno + Pyodide + the two wheels), which is the intended `fetch-pyodide-assets`
behavior and is wholly separate from runtime.

## Surprises / corrections (carry into Phase 3)

1. **Deno is detected as Node, not Deno.** Pyodide's loader computes `IN_NODE`
   from `process.versions.node` — which Deno populates — so it takes the
   **Node-fs load path**, not a Deno path. Pyodide 0.29.4 has **no
   `Deno.readFile` branch**; its only non-Node path is browser `fetch` (would
   need network). So the Node-fs path is the *correct and only* offline path.
2. **Emscripten needs CommonJS globals the Deno ESM realm lacks.** `pyodide.asm.js`
   (Emscripten output) calls bare `require("fs"/"path"/"crypto")`, `__dirname`,
   `__filename`. In a Deno ES module these are undefined → `ReferenceError`. **Fix
   (required in `runner.ts`):** before importing `pyodide.mjs`, set on `globalThis`:
   - `require = createRequire(import.meta.url)` (from `node:module`),
   - `__dirname = <assetDir>`, `__filename = <assetDir>/pyodide.asm.js`.
   Bare identifiers fall through to `globalThis`, so this satisfies Emscripten.
   These node-builtin imports are **not** blocked by `--deny-import`/`--no-npm`
   (those gate remote/npm only).
3. **The npm `import("ws")` is never reached.** Pyodide's `initNodeModules`
   short-circuits (`typeof A < "u"`, its bundler require-shim) and returns before
   the `await import("ws")` line. So `--no-npm` causes **no** failure. Confirmed:
   only `node:url/fs/fs-promises/vm/path` are imported (all Deno-supported).
4. **openpyxl + et_xmlfile are NOT in the Pyodide distribution.** Not in
   `pyodide-lock.json`, not on disk. numpy/pandas/scipy/**micropip** ARE present.
   - S1 vendors the two pure-python wheels and loads them via **direct file:// URL**
     `loadPackage(["file://…/et_xmlfile….whl","file://…/openpyxl….whl"])`.
   - **Phase 3 mismatch to fix:** plan line 354 preloads
     `loadPackage(["numpy","pandas","scipy","openpyxl"])` **by name** — that throws
     `No known package with name 'openpyxl'` against the stock lock. It only works
     once `build-pyodide-lock.mjs` (plan line 303) produces a **custom lock** that
     names openpyxl+et_xmlfile. Either generate the custom lock (preferred, per
     plan) OR load the wheels by URL as S1 does.
5. **`packageBaseUrl` is unnecessary.** Plan lines 31/354 pass
   `loadPyodide({ indexURL, lockFileURL, packageBaseUrl })`. S1 used only
   `{ indexURL, lockFileURL }` and `loadPackage` resolved distribution wheels
   relative to `indexURL` correctly. `packageBaseUrl` can be dropped (or kept
   equal to `indexURL`) — it is not load-bearing here.

## Gotchas for Phase 3

- `indexURL` **must end in a trailing slash**; pass the **absolute** asset dir.
- Asset dir is passed as **argv** (`Deno.args[0]`), never `Deno.env` (blocked by
  `--deny-env`). `DENO_NO_UPDATE_CHECK=1` goes in the **spawn env** (read by the
  Deno runtime itself, not by the program).
- `--allow-read` must be scoped to the asset dir **and the vendored wheels must
  live inside it** (S1 places them in the pyodide dir) so reads stay in scope.
- Cold load (loadPyodide + loadPackage of numpy/pandas/scipy/openpyxl) is several
  seconds — informs the Phase 6 cold-start exec-timeout default.
