// Pyodide runner — the UNTRUSTED side. Deno entry point, EXCLUDED from the tsc
// build (uses Deno globals) and shipped to dist/ as raw .ts (Deno runs it
// directly). Hardens spikes S1 (offline Pyodide-on-Deno) and S2 (IPC integrity)
// into product.
//
// Launched by the Node manager (Phase 4) with the committed deny-belt, e.g.:
//   DENO_NO_UPDATE_CHECK=1 deno run --no-prompt --deny-net --deny-run \
//     --deny-write --deny-env --deny-ffi --deny-sys --deny-import --no-remote \
//     --no-npm --cached-only --no-config --allow-read=<assetDir> \
//     runner.ts <assetDir> <generation>
//
// argv: [assetDir, generation]. The asset dir is passed as ARGV (never Deno.env,
// which --deny-env blocks). DENO_NO_UPDATE_CHECK lives in the spawn env, read by
// the Deno runtime itself.
//
// SECURITY (spike S2 finding A): realm lockdown is NOT stdout containment —
// (await import("node:fs")).writeSync(1,…) still reaches stdout under the
// deny-belt. The load-bearing control is Node-side frame validation keyed on the
// secret requestId/seq/generation, which this runner NEVER exposes to untrusted
// Python (only code/argv/stdin/files cross into Pyodide; integrity fields stay
// in JS closure). Lockdown is hardening that blocks the easy write primitives.

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import {
	type Frame,
	FrameTooLargeError,
	type FsEntry,
	MAX_FRAME_BYTES,
	PYODIDE_EXT_STAGING_DIR,
	type ReadyFrame,
	type RunRequest,
	type RunResponse,
	decodeFrames,
	encodeFrame,
} from "./protocol.ts";

// ── Capture host primitives BEFORE lockdown (closure-held, never on globalThis) ─
// deno-lint-ignore no-explicit-any
const denoRef = (globalThis as any).Deno;
const consoleRef = (globalThis as any).console;
const stdoutWriteSync: (b: Uint8Array) => number = denoRef.stdout.writeSync.bind(denoRef.stdout);
const stderrWriteSync: (b: Uint8Array) => number = denoRef.stderr.writeSync.bind(denoRef.stderr);
const stdinReadable: ReadableStream<Uint8Array> = denoRef.stdin.readable;
const denoExit: (code: number) => never = denoRef.exit.bind(denoRef);
const denoArgs: string[] = denoRef.args;
const subtleDigest = crypto.subtle.digest.bind(crypto.subtle);

const assetDir: string | undefined = denoArgs[0];
const preloadPackages = JSON.parse(denoArgs[1] ?? "[]") as string[];
const generation = Number(denoArgs[2] ?? "0");
if (!assetDir) {
	stdoutWriteSync(new TextEncoder().encode("RUNNER FATAL: asset dir not provided as argv[0]\n"));
	denoExit(2);
}

// indexURL must be absolute and end with "/"; Pyodide resolves the wasm,
// python_stdlib.zip, wheels and stock lock relative to it.
const indexURL = assetDir.endsWith("/") ? assetDir : `${assetDir}/`;
const assetRoot = indexURL.replace(/\/$/, "");

// ── Node-compat globals required for Emscripten/Pyodide under Deno's ESM realm ─
// Deno populates process.versions.node, so Pyodide takes the Node-fs load path
// (its only offline path — there is no Deno.readFile branch). Emscripten's
// pyodide.asm.js uses bare require/__dirname/__filename, absent in a Deno ESM
// module; provide them as globals so it resolves. These node-builtin requires are
// NOT blocked by --deny-import/--no-npm (those gate remote/npm only).
// deno-lint-ignore no-explicit-any
const g = globalThis as any;
g.require = createRequire(import.meta.url);
g.__dirname = assetRoot;
g.__filename = `${assetRoot}/pyodide.asm.js`;

function emit(frame: Frame): void {
	const bytes = encodeFrame(frame);
	let written = 0;
	while (written < bytes.byteLength) {
		written += stdoutWriteSync(bytes.subarray(written)); // loop: a pipe write may be partial
	}
}

// ── Pyodide instance + MEMFS handle (assigned by the init sequence below) ────
// deno-lint-ignore no-explicit-any
let pyodide: any;
// deno-lint-ignore no-explicit-any
let FS: any;
const importToPackage = new Map<string, string>();

/**
 * Adversarial self-test (spike S2 hard gate). Runs AFTER realm lockdown and
 * BEFORE `ready`: proves the deletable host primitives are actually gone and that
 * Pyodide's `js` proxy retains no reachable reference to them. Deleted globals +
 * closure privacy do NOT by themselves prove no usable writer survived, so we
 * verify it directly here. A failure throws → the init sequence kills the child
 * and the run that triggered the spawn fails (admission fails).
 */
function selfTest() {
	const gg = globalThis as any;
	for (const name of ["Deno", "console", "require", "__dirname", "__filename"]) {
		if (gg[name] !== undefined) throw new Error(`realm lockdown self-test failed: globalThis.${name} survived`);
	}
	// Pyodide's `js` foreign module proxies globalThis; confirm the deleted host
	// primitives are unreachable through it.
	const probe = pyodide.runPython("import js\n[hasattr(js, _n) for _n in ('Deno', 'console', 'require')]");
	let reachable;
	try {
		reachable = probe && typeof probe.toJs === "function" ? probe.toJs() : probe;
	} finally {
		if (probe && typeof probe.destroy === "function") probe.destroy();
	}
	if (Array.isArray(reachable) && reachable.some(Boolean)) {
		throw new Error("realm lockdown self-test failed: js proxy still exposes a deleted host primitive");
	}
}

// ── INIT SEQUENCE (spike S1 + S2) ───────────────────────────────────────────
// Load offline Pyodide + packages, lock down the realm, run the adversarial
// self-test — ALL before announcing `ready`. Any failure here is fatal: write a
// diagnostic to stderr and exit non-zero so the Node manager retires the child
// and fails the run that triggered the spawn.
try {
	// deno-lint-ignore no-explicit-any
	const pyodideModule = await import(`file://${indexURL}pyodide.mjs`);
	pyodide = await pyodideModule.loadPyodide({
		indexURL,
		lockFileURL: `${indexURL}pyodide-lock.json`,
		// Discard Pyodide's own load-time banner/print; per-run capture is wired below.
		stdout: () => {},
		stderr: () => {},
	});

	// Retain only the small import-name → package-name index from the local lock.
	// `loadPackagesFromImports` is attempted per run, with this index providing a
	// deterministic offline fallback in the locked-down Deno realm.
	const lock = JSON.parse(denoRef.readTextFileSync(`${assetRoot}/pyodide-lock.json`)) as {
		packages: Record<string, { imports?: string[] }>;
	};
	for (const [packageName, metadata] of Object.entries(lock.packages)) {
		for (const importName of metadata.imports ?? []) {
			if (!importToPackage.has(importName)) importToPackage.set(importName, packageName);
		}
	}

	// Operators can trade cold-start latency against resident RSS. Packages not
	// preloaded here are loaded on demand from the same offline lock per run.
	if (preloadPackages.length > 0) await pyodide.loadPackage(preloadPackages);
	// openpyxl + et_xmlfile are NOT in the distribution; load the vendored pure-python
	// wheels by local file:// URL (discovered in the asset dir). loadPackage reads
	// them via node:fs under --allow-read — no network. (Phase 0 Discoveries: the
	// stock lock has no openpyxl, so loadPackage-by-name would throw; file:// wheels
	// are the S1-proven offline path. The supplementary custom lock from
	// build-pyodide-lock.mjs is not required by this runner.)
	const wheelNames: string[] = [];
	for (const entry of denoRef.readDirSync(assetRoot)) {
		if (entry.isFile && (/^openpyxl-.*\.whl$/.test(entry.name) || /^et_xmlfile-.*\.whl$/.test(entry.name))) {
			wheelNames.push(entry.name);
		}
	}
	// et_xmlfile before openpyxl (dependency order).
	wheelNames.sort((a, b) => (a.startsWith("et_xmlfile") ? -1 : b.startsWith("et_xmlfile") ? 1 : 0));
	await pyodide.loadPackage(wheelNames.map((w) => `file://${indexURL}${w}`));

	FS = pyodide.FS;

	// ── REALM LOCKDOWN — before any untrusted runPythonAsync (spike S2) ─────────
	// Delete every deletable host / Node-compat write primitive. import("node:fs")
	// cannot be deleted (it is syntax), so this is hardening, not containment — the
	// Node-side validator is the real guarantee (see file header).
	delete g.Deno;
	delete g.console;
	delete g.require;
	delete g.__dirname;
	delete g.__filename;

	// ── ADVERSARIAL SELF-TEST — must pass before any untrusted code runs ─────────
	selfTest();
} catch (err) {
	const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
	stderrWriteSync(new TextEncoder().encode(`RUNNER FATAL: pyodide init / lockdown self-test failed: ${msg}\n`));
	denoExit(3);
}

// ── MEMFS helpers ───────────────────────────────────────────────────────────
function mkdirTree(dir: string): void {
	FS.mkdirTree(dir);
}

interface TreeNode {
	path: string;
	kind: "file" | "dir";
	mode: number;
	size: number;
}

/** Walk the subtree under `root` (excluding `root` itself), returning metadata only. */
function walkTree(root: string): TreeNode[] {
	const out: TreeNode[] = [];
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = FS.readdir(dir) as string[];
		} catch {
			return;
		}
		for (const name of names) {
			if (name === "." || name === "..") continue;
			const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
			const { mode, size } = FS.stat(full);
			if (FS.isDir(mode)) {
				out.push({ path: full, kind: "dir", mode: mode & 0o777, size: 0 });
				walk(full);
			} else if (FS.isFile(mode)) {
				out.push({ path: full, kind: "file", mode: mode & 0o777, size });
			}
		}
	};
	walk(root);
	return out;
}

function readFileBytes(path: string): Uint8Array<ArrayBuffer> {
	return FS.readFile(path, { encoding: "binary" }) as Uint8Array<ArrayBuffer>;
}

function depth(path: string): number {
	return path.split("/").length;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const hash = new Uint8Array(await subtleDigest("SHA-256", bytes));
	let hex = "";
	for (const byte of hash) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

async function loadImportedPackages(code: string): Promise<void> {
	// Parse imports structurally with Python's AST. In this Deno/Node-compat realm,
	// loadPackagesFromImports may return without installing a known package after
	// host globals are locked down, so explicitly load the locally-mapped packages.
	pyodide.globals.set("__sqlfs_import_scan_code", code);
	const importsProxy = pyodide.runPython(`
import ast as __sqlfs_ast
__sqlfs_import_tree = __sqlfs_ast.parse(__sqlfs_import_scan_code)
sorted({
    name
    for node in __sqlfs_ast.walk(__sqlfs_import_tree)
    for name in (
        [alias.name.split(".")[0] for alias in node.names]
        if isinstance(node, __sqlfs_ast.Import)
        else [node.module.split(".")[0]]
        if isinstance(node, __sqlfs_ast.ImportFrom) and node.module
        else []
    )
})
`);
	let importNames: string[];
	try {
		importNames = importsProxy.toJs() as string[];
	} finally {
		importsProxy.destroy();
		pyodide.globals.delete("__sqlfs_import_scan_code");
	}
	const packages = [...new Set(importNames.map((name) => importToPackage.get(name)).filter((name): name is string => !!name))];

	// The package loader's Node-compat path needs host globals that realm lockdown
	// removes from Python's `js` proxy. Restore them only around trusted vendored
	// package installation, then prove they are unreachable before user code runs.
	g.Deno = denoRef;
	g.console = consoleRef;
	g.require = createRequire(import.meta.url);
	g.__dirname = assetRoot;
	g.__filename = `${assetRoot}/pyodide.asm.js`;
	try {
		await pyodide.loadPackagesFromImports(code);
		if (packages.length > 0) await pyodide.loadPackage(packages);
	} finally {
		delete g.Deno;
		delete g.console;
		delete g.require;
		delete g.__dirname;
		delete g.__filename;
	}
	selfTest();
}

// ── Run one request ─────────────────────────────────────────────────────────
async function runOne(req: RunRequest): Promise<RunResponse> {
	const cwd = req.cwd && req.cwd.startsWith("/") ? req.cwd : "/home/pyodide";
	mkdirTree(cwd);

	// Stage the input subtree (dirs + files) into MEMFS.
	for (const f of req.files) {
		if (f.kind === "dir") {
			mkdirTree(f.path);
		} else {
			const dir = f.path.slice(0, f.path.lastIndexOf("/")) || "/";
			mkdirTree(dir);
			FS.writeFile(f.path, new Uint8Array(Buffer.from(f.data, "base64")));
		}
		if (typeof f.mode === "number") FS.chmod(f.path, f.mode);
	}

	// Snapshot the cwd subtree AFTER staging, BEFORE running user code — this is
	// the diff baseline (excludes staging infrastructure dirs, which pre-exist
	// from the caller's SqlFs tree).
	const baseFiles = new Map<string, { size: number; sha256: string }>();
	// Track KIND per path (not just presence) so a file↔dir replacement at the same
	// path is detectable — otherwise `os.remove('x'); os.mkdir('x')` is invisible.
	const baseKind = new Map<string, "file" | "dir">();
	for (const node of walkTree(cwd)) {
		baseKind.set(node.path, node.kind);
		if (node.kind === "file") {
			const bytes = readFileBytes(node.path);
			baseFiles.set(node.path, { size: node.size, sha256: await sha256(bytes) });
		}
	}

	// Resolve imports against the vendored lock before user code executes. This
	// keeps the child fully offline while avoiding resident cost for unused packages.
	await loadImportedPackages(req.code);

	// Prelude: argv + cwd + stdin, plus redirect sys.stdout/sys.stderr to StringIO
	// buffers. We read those buffers' getvalue() after the run — this captures ALL
	// Python output regardless of trailing newlines / flushing (Pyodide's batched
	// JS stdout only flushes per-line, dropping a final unterminated line).
	// argv/stdin/cwd are the user's own inputs — safe to expose; the secret
	// integrity fields are NEVER passed into Python.
	pyodide.globals.set("__sqlfs_argv", JSON.stringify(req.argv ?? []));
	pyodide.globals.set("__sqlfs_stdin", req.stdin ? Buffer.from(req.stdin, "base64").toString("utf-8") : "");
	pyodide.globals.set("__sqlfs_cwd", cwd);
	pyodide.globals.set("__sqlfs_env", JSON.stringify(req.env ?? {}));
	await pyodide.runPythonAsync(`
import sys, os, io, json as __json
sys.argv = __json.loads(__sqlfs_argv) or [""]
os.chdir(__sqlfs_cwd)
sys.stdin = io.StringIO(__sqlfs_stdin)
# CPython parity: a FILE script runs with its OWN directory at sys.path[0] so sibling
# imports resolve (argv[0] is "-c"/"-"/"" for the inline/stdin/bare modes, where cwd
# applies). Snapshot sys.path so the insert is undone per run (the warm child persists it).
__sqlfs_syspath_saved = list(sys.path)
__sqlfs_argv0 = sys.argv[0] if sys.argv else ""
if __sqlfs_argv0 and __sqlfs_argv0 not in ("-c", "-"):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__sqlfs_argv0)))
# Snapshot the FULL os.environ, then apply the exec's exported env. The warm child
# persists os.environ across runs, so we snapshot/restore the WHOLE mapping (not just
# injected keys) to keep env strictly per-execution — a script that sets a NEW
# os.environ key cannot leak it into the next run.
__sqlfs_env_saved = dict(os.environ)
os.environ.update(__json.loads(__sqlfs_env))
os.environ.setdefault("MPLBACKEND", "Agg")
__sqlfs_out = io.StringIO()
__sqlfs_err = io.StringIO()
sys.stdout = __sqlfs_out
sys.stderr = __sqlfs_err
`);

	let exitCode = 0;
	let jsError = "";
	try {
		// User code runs in a FRESH namespace each call (bounds variable scope;
		// sys.modules / package globals persist within the session — design D3).
		// Seed it like CPython: __name__ = "__main__" for every mode (so the common
		// `if __name__ == "__main__":` guard fires), and __file__ = argv[0] for the
		// script-file form (argv[0] is "-c"/"-"/"" for the inline/stdin/bare modes,
		// where CPython sets no __file__).
		const ns = pyodide.globals.get("dict")();
		ns.set("__name__", "__main__");
		const argv0 = req.argv?.[0] ?? "";
		if (argv0 && argv0 !== "-c" && argv0 !== "-") ns.set("__file__", argv0);
		try {
			await pyodide.runPythonAsync(req.code, { globals: ns });
		} finally {
			ns.destroy();
		}
	} catch (err) {
		exitCode = 1;
		jsError = err instanceof Error ? (err.message ?? String(err)) : String(err);
	}

	// Read the captured buffers, then restore the real streams.
	const outProxy = pyodide.globals.get("__sqlfs_out");
	const errProxy = pyodide.globals.get("__sqlfs_err");
	const capturedOut = (outProxy.getvalue() as string) ?? "";
	let capturedErr = (errProxy.getvalue() as string) ?? "";
	outProxy.destroy();
	errProxy.destroy();
	// Restore the real streams AND the prior os.environ (undo this run's env injection).
	await pyodide.runPythonAsync(`
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
sys.path[:] = __sqlfs_syspath_saved
os.environ.clear()
os.environ.update(__sqlfs_env_saved)
__sqlfs_env_saved.clear()
`);
	if (jsError) capturedErr = capturedErr && !capturedErr.endsWith("\n") ? `${capturedErr}\n${jsError}` : capturedErr + jsError;

	// ── Diff the cwd subtree (dirs + files) against the staged baseline ───────
	const after = walkTree(cwd);
	const afterKind = new Map<string, "file" | "dir">();
	for (const node of after) afterKind.set(node.path, node.kind);

	const createdDirs: FsEntry[] = [];
	const createdFiles: FsEntry[] = [];
	const modified: FsEntry[] = [];
	for (const node of after) {
		if (node.kind === "dir") {
			// New, OR a path that was a FILE before (file→dir replacement) — both are a
			// "created dir" the drain materializes (replacing the old file in place).
			if (baseKind.get(node.path) !== "dir") createdDirs.push({ path: node.path, kind: "dir", mode: node.mode, data: "" });
			continue;
		}
		const bytes = readFileBytes(node.path);
		if (baseKind.get(node.path) !== "file") {
			createdFiles.push({
				path: node.path,
				kind: "file",
				mode: node.mode,
				data: Buffer.from(bytes).toString("base64"),
			}); // new, or dir→file replacement
			continue;
		}
		const baseline = baseFiles.get(node.path);
		if (!baseline || baseline.size !== node.size || baseline.sha256 !== (await sha256(bytes))) {
			modified.push({
				path: node.path,
				kind: "file",
				mode: node.mode,
				data: Buffer.from(bytes).toString("base64"),
			});
		}
	}
	// dirs-before-files, dirs shallow→deep, so the drain can apply created in order.
	createdDirs.sort((a, b) => depth(a.path) - depth(b.path));
	const created: FsEntry[] = [...createdDirs, ...createdFiles];

	// deleted: a baseline path gone from the after-tree, EXCEPT those shadowed by an
	// ancestor that is now a FILE (a dir→file replacement implicitly drops the old
	// children; emitting them as separate deletes would also collide with the created
	// file under drain validation). Deepest-first (children before parents).
	const cwdNoSlash = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
	const shadowedByFile = (p: string): boolean => {
		let parent = p.slice(0, p.lastIndexOf("/"));
		while (parent.length > cwdNoSlash.length && parent.startsWith(`${cwdNoSlash}/`)) {
			if (afterKind.get(parent) === "file") return true;
			parent = parent.slice(0, parent.lastIndexOf("/"));
		}
		return false;
	};
	const deleted = [...baseKind.keys()]
		.filter((p) => !afterKind.has(p) && !shadowedByFile(p))
		.sort((a, b) => depth(b) - depth(a));

	// Wipe the ENTIRE cwd subtree (files + dirs, deepest-first) so the next exec
	// in this warm child starts from a clean cwd — no leftover dirs leak across
	// execs. (sys.modules / package globals still persist — design D3.)
	for (const node of walkTree(cwd).sort((a, b) => depth(b.path) - depth(a.path))) {
		try {
			if (node.kind === "file") FS.unlink(node.path);
			else FS.rmdir(node.path);
		} catch {
			/* already gone */
		}
	}

	// Also wipe the reserved out-of-cwd staging dir (a `python3 FILE` resolved
	// outside cwd was staged there) so it never leaks across execs in the warm child.
	for (const node of walkTree(PYODIDE_EXT_STAGING_DIR).sort((a, b) => depth(b.path) - depth(a.path))) {
		try {
			if (node.kind === "file") FS.unlink(node.path);
			else FS.rmdir(node.path);
		} catch {
			/* already gone */
		}
	}
	try {
		FS.rmdir(PYODIDE_EXT_STAGING_DIR);
	} catch {
		/* not created this run */
	}

	return {
		type: exitCode === 0 ? "result" : "error",
		requestId: req.requestId,
		seq: req.seq,
		generation: req.generation,
		stdout: Buffer.from(capturedOut, "utf-8").toString("base64"),
		stderr: Buffer.from(capturedErr, "utf-8").toString("base64"),
		exitCode,
		created,
		modified,
		deleted,
	};
}

// ── IPC loop ─────────────────────────────────────────────────────────────────
// Announce readiness (one-time handshake; carries generation only).
const ready: ReadyFrame = { type: "ready", generation };
emit(ready);

let chunks: Uint8Array<ArrayBufferLike>[] = [];
let totalBytes = 0;
let expectedBodyBytes = -1;

function peekFrameLength(): number {
	const header = new Uint8Array(4);
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, 4 - offset);
		header.set(chunk.subarray(0, take), offset);
		offset += take;
		if (offset === 4) break;
	}
	return new DataView(header.buffer).getUint32(0, false);
}

const reader = stdinReadable.getReader();
for (;;) {
	const { value, done } = await reader.read();
	if (done) break;
	chunks.push(value);
	totalBytes += value.byteLength;
	for (;;) {
		if (expectedBodyBytes < 0) {
			if (totalBytes < 4) break;
			expectedBodyBytes = peekFrameLength();
			if (expectedBodyBytes > MAX_FRAME_BYTES) throw new FrameTooLargeError(expectedBodyBytes);
		}
		if (totalBytes < 4 + expectedBodyBytes) break;

		const merged = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const { frames, rest } = decodeFrames(merged);
		chunks = rest.byteLength > 0 ? [rest] : [];
		totalBytes = rest.byteLength;
		expectedBodyBytes = -1;
		for (const frame of frames) {
			if (frame.type === "run") {
				const resp = await runOne(frame);
				emit(resp);
			}
			// Non-run inbound frames are ignored — Node only sends `run`.
		}
	}
}

denoExit(0);
