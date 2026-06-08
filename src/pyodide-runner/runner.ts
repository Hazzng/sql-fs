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
	type FsEntry,
	type ReadyFrame,
	type RunRequest,
	type RunResponse,
	decodeFrames,
	encodeFrame,
} from "./protocol.ts";

// ── Capture host primitives BEFORE lockdown (closure-held, never on globalThis) ─
// deno-lint-ignore no-explicit-any
const denoRef = (globalThis as any).Deno;
const stdoutWriteSync: (b: Uint8Array) => number = denoRef.stdout.writeSync.bind(denoRef.stdout);
const stdinReadable: ReadableStream<Uint8Array> = denoRef.stdin.readable;
const denoExit: (code: number) => never = denoRef.exit.bind(denoRef);
const denoArgs: string[] = denoRef.args;

const assetDir: string | undefined = denoArgs[0];
const generation = Number(denoArgs[1] ?? "0");
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

// ── Load Pyodide + packages (spike S1 proven, fully offline) ────────────────
// deno-lint-ignore no-explicit-any
const pyodideModule = await import(`file://${indexURL}pyodide.mjs`);
const loadPyodide = pyodideModule.loadPyodide;

const pyodide = await loadPyodide({
	indexURL,
	lockFileURL: `${indexURL}pyodide-lock.json`,
	// Discard Pyodide's own load-time banner/print; per-run capture is wired below.
	stdout: () => {},
	stderr: () => {},
});

// numpy/pandas/scipy ship in the distribution → load by name.
await pyodide.loadPackage(["numpy", "pandas", "scipy"]);
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

const FS = pyodide.FS;

// ── REALM LOCKDOWN — before any untrusted runPythonAsync (spike S2) ─────────
// Delete every deletable host / Node-compat write primitive. import("node:fs")
// cannot be deleted (it is syntax), so this is hardening, not containment — the
// Node-side validator is the real guarantee (see file header).
delete g.Deno;
delete g.console;
delete g.require;
delete g.__dirname;
delete g.__filename;

// ── MEMFS helpers ───────────────────────────────────────────────────────────
function mkdirTree(dir: string): void {
	FS.mkdirTree(dir);
}

interface TreeNode {
	path: string;
	kind: "file" | "dir";
	mode: number;
	bytes?: Uint8Array; // present only for files
}

/** Walk the subtree under `root` (excluding `root` itself), returning every dir
 *  and file with its mode (and bytes for files). */
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
			const { mode } = FS.stat(full);
			if (FS.isDir(mode)) {
				out.push({ path: full, kind: "dir", mode: mode & 0o777 });
				walk(full);
			} else if (FS.isFile(mode)) {
				out.push({ path: full, kind: "file", mode: mode & 0o777, bytes: readFileBytes(full) });
			}
		}
	};
	walk(root);
	return out;
}

function readFileBytes(path: string): Uint8Array {
	return FS.readFile(path, { encoding: "binary" }) as Uint8Array;
}

function depth(path: string): number {
	return path.split("/").length;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
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
	const baseFiles = new Map<string, Uint8Array>();
	const basePaths = new Set<string>();
	for (const node of walkTree(cwd)) {
		basePaths.add(node.path);
		if (node.kind === "file" && node.bytes) baseFiles.set(node.path, node.bytes);
	}

	// Prelude: argv + cwd + stdin, plus redirect sys.stdout/sys.stderr to StringIO
	// buffers. We read those buffers' getvalue() after the run — this captures ALL
	// Python output regardless of trailing newlines / flushing (Pyodide's batched
	// JS stdout only flushes per-line, dropping a final unterminated line).
	// argv/stdin/cwd are the user's own inputs — safe to expose; the secret
	// integrity fields are NEVER passed into Python.
	pyodide.globals.set("__sqlfs_argv", JSON.stringify(req.argv ?? []));
	pyodide.globals.set("__sqlfs_stdin", req.stdin ? Buffer.from(req.stdin, "base64").toString("utf-8") : "");
	pyodide.globals.set("__sqlfs_cwd", cwd);
	await pyodide.runPythonAsync(`
import sys, os, io, json as __json
sys.argv = __json.loads(__sqlfs_argv) or [""]
os.chdir(__sqlfs_cwd)
sys.stdin = io.StringIO(__sqlfs_stdin)
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
	await pyodide.runPythonAsync("sys.stdout = sys.__stdout__\nsys.stderr = sys.__stderr__");
	if (jsError) capturedErr = capturedErr && !capturedErr.endsWith("\n") ? `${capturedErr}\n${jsError}` : capturedErr + jsError;

	// ── Diff the cwd subtree (dirs + files) against the staged baseline ───────
	const after = walkTree(cwd);
	const createdDirs: FsEntry[] = [];
	const createdFiles: FsEntry[] = [];
	const modified: FsEntry[] = [];
	const afterPaths = new Set<string>();
	for (const node of after) {
		afterPaths.add(node.path);
		if (node.kind === "dir") {
			if (!basePaths.has(node.path)) createdDirs.push({ path: node.path, kind: "dir", mode: node.mode, data: "" });
			continue;
		}
		const bytes = node.bytes ?? new Uint8Array(0);
		const before = baseFiles.get(node.path);
		const entry: FsEntry = { path: node.path, kind: "file", mode: node.mode, data: Buffer.from(bytes).toString("base64") };
		if (before === undefined) createdFiles.push(entry);
		else if (!sameBytes(before, bytes)) modified.push(entry);
	}
	// dirs-before-files, dirs shallow→deep, so the drain can apply created in order.
	createdDirs.sort((a, b) => depth(a.path) - depth(b.path));
	const created: FsEntry[] = [...createdDirs, ...createdFiles];
	// deleted: any baseline path gone, deepest-first (children before parents).
	const deleted = [...basePaths].filter((p) => !afterPaths.has(p)).sort((a, b) => depth(b) - depth(a));

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

let buf = new Uint8Array(0);
const reader = stdinReadable.getReader();
for (;;) {
	const { value, done } = await reader.read();
	if (done) break;
	const merged = new Uint8Array(buf.byteLength + value.byteLength);
	merged.set(buf, 0);
	merged.set(value, buf.byteLength);
	const { frames, rest } = decodeFrames(merged);
	buf = rest;
	for (const frame of frames) {
		if (frame.type === "run") {
			const resp = await runOne(frame);
			emit(resp);
		}
		// Non-run inbound frames are ignored — Node only sends `run`.
	}
}

denoExit(0);
