#!/usr/bin/env node
/**
 * Fetch the vendored Pyodide runtime assets into ./vendor/ (git-ignored).
 *
 * Downloads, under PINNED versions, the exact artifacts validated by spike S1:
 *   - the Deno binary                 → vendor/deno/deno
 *   - the Pyodide full distribution   → vendor/pyodide/   (wasm + python_stdlib.zip
 *                                        + numpy/pandas/scipy wheels + stock lock)
 *   - openpyxl + et_xmlfile wheels    → vendor/pyodide/   (absent from the dist)
 *
 * Idempotent: skips any artifact already present whose checksum still matches.
 *
 * INTEGRITY. Platform-independent runtime bytes are SHA-256-pinned to the exact
 * artifacts spike S1 validated (pyodide.mjs / pyodide.asm.wasm / python_stdlib.zip
 * and the two pure-python wheels). The Deno binary is platform-specific, so it is
 * pinned PER TARGET in `DENO_SHA256` and verified after extraction: an unpinned
 * target OR a checksum mismatch is a HARD FAILURE — we never run an unverified Deno
 * binary (all four supported targets are pinned).
 *
 * Requires `curl`, `unzip`, and `tar` (with bzip2) on PATH — present on macOS and
 * installed in the Docker builder stage. Mirrors the proven spike
 * `s1-pyodide-deno.sh` curl/unzip/tar flow.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Pinned versions (must match spike S1 / Phase 0 Discoveries) ──────────────
const PINS = {
	deno: "v2.8.2",
	pyodide: "0.29.4",
	openpyxlWheel: "openpyxl-3.1.5-py2.py3-none-any.whl",
	etXmlfileWheel: "et_xmlfile-2.0.0-py3-none-any.whl",
};

const WHEEL_URLS = {
	[PINS.openpyxlWheel]:
		"https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl",
	[PINS.etXmlfileWheel]:
		"https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl",
};

// SHA-256 of the platform-independent artifacts, pinned to the exact bytes
// spike S1 validated. Mismatch ⇒ hard failure (supply-chain / corruption guard).
const SHA256 = {
	"pyodide.mjs": "8fdfed5eaf81bde14bcdeaeea11f2672675b2362248f8537446b6fda5e4a4751",
	"pyodide.asm.wasm": "10090fe41e019ae669d512e1f747021a8db2aaab0f6dd6f85fa9368c55d681e3",
	"python_stdlib.zip": "92cb24faa546818f3ef4050fd5bd2b6487bd2042efed2113af141d035f30efb4",
	[PINS.openpyxlWheel]: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
	[PINS.etXmlfileWheel]: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
};

// SHA-256 of the EXTRACTED Deno binary, per target, for PINS.deno. The binary is
// platform-specific, so it's keyed by target rather than a single hash. After
// download/extraction the binary is verified against this map: an UNPINNED target
// or a MISMATCH is a HARD FAILURE (supply-chain / tamper guard) — we never run an
// unverified Deno binary. To bump PINS.deno: download deno-<target>.zip for every
// target below, and record sha256 of the extracted `deno`.
const DENO_SHA256 = {
	"aarch64-apple-darwin": "9d25a1a5a67579eb607ed27a73141548b163e29df38735bc5556b7d887992435",
	"x86_64-apple-darwin": "a06e411d2da878b9240ecab047ea4ad3f2d1297dfff6bae9de7059baf34733dd",
	"x86_64-unknown-linux-gnu": "30761b46413a814d5f83081bf6011e0c900a5b4154f64b03a065e97511079fa0",
	"aarch64-unknown-linux-gnu": "f7dc66b53f77133b4ca9a24c77d1fb48e49cd8c26a4043e49f6b0b8195f09d80",
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor");
const DENO_DIR = join(VENDOR, "deno");
const DENO_BIN = join(DENO_DIR, "deno");
const PYODIDE_DIR = join(VENDOR, "pyodide");
const CACHE = join(VENDOR, ".cache");

function log(msg) {
	console.error(`[fetch-pyodide] ${msg}`);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verify(path, name) {
	const expected = SHA256[name];
	if (!expected) return;
	const actual = sha256(path);
	if (actual !== expected) {
		throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
	}
	log(`verified ${name} (sha256 ok)`);
}

function curl(url, dest) {
	execFileSync("curl", ["-fSL", "--retry", "3", "-o", dest, url], { stdio: ["ignore", "ignore", "inherit"] });
}

function denoTarget() {
	const key = `${platform()}-${arch()}`;
	const map = {
		"darwin-arm64": "aarch64-apple-darwin",
		"darwin-x64": "x86_64-apple-darwin",
		"linux-arm64": "aarch64-unknown-linux-gnu",
		"linux-x64": "x86_64-unknown-linux-gnu",
	};
	const target = map[key];
	if (!target) throw new Error(`unsupported host ${key} for Deno download`);
	return target;
}

function verifyDeno(target) {
	const expected = DENO_SHA256[target];
	const actual = sha256(DENO_BIN);
	if (!expected) {
		// HARD FAIL — never run an unverified Deno binary. Add the target's hash to
		// DENO_SHA256 (download deno-<target>.zip for PINS.deno and sha256 the binary).
		throw new Error(
			`Deno binary for ${target} is not pinned in DENO_SHA256 (its sha256 is ${actual}) — add it before building`,
		);
	}
	if (actual !== expected) {
		throw new Error(`Deno binary checksum mismatch for ${target}: expected ${expected}, got ${actual}`);
	}
	log(`verified Deno binary for ${target} (sha256 ok)`);
}

function fetchDeno() {
	const target = denoTarget();
	if (existsSync(DENO_BIN)) {
		verifyDeno(target); // verify even when already present (catches a swapped binary)
		log(`Deno ${PINS.deno} already present`);
		return;
	}
	mkdirSync(DENO_DIR, { recursive: true });
	mkdirSync(CACHE, { recursive: true });
	const zip = join(CACHE, `deno-${PINS.deno}-${target}.zip`);
	if (!existsSync(zip)) {
		log(`downloading Deno ${PINS.deno} (${target})…`);
		curl(`https://dl.deno.land/release/${PINS.deno}/deno-${target}.zip`, zip);
	}
	execFileSync("unzip", ["-oq", zip, "-d", DENO_DIR], { stdio: "inherit" });
	chmodSync(DENO_BIN, 0o755);
	// Strip macOS quarantine xattr if present (no-op elsewhere).
	try {
		execFileSync("xattr", ["-d", "com.apple.quarantine", DENO_BIN], { stdio: "ignore" });
	} catch {
		/* not macOS / no xattr */
	}
	if (!existsSync(DENO_BIN)) throw new Error("Deno binary not present after extraction");
	verifyDeno(target);
	log(`Deno ${PINS.deno} ready at ${DENO_BIN}`);
}

function fetchPyodide() {
	const marker = join(PYODIDE_DIR, "pyodide.mjs");
	if (existsSync(marker)) {
		log(`Pyodide ${PINS.pyodide} already extracted`);
	} else {
		mkdirSync(CACHE, { recursive: true });
		const tarball = join(CACHE, `pyodide-${PINS.pyodide}.tar.bz2`);
		if (!existsSync(tarball)) {
			log(`downloading Pyodide ${PINS.pyodide} full distribution (~408 MB)…`);
			curl(
				`https://github.com/pyodide/pyodide/releases/download/${PINS.pyodide}/pyodide-${PINS.pyodide}.tar.bz2`,
				tarball,
			);
		}
		log("extracting Pyodide distribution…");
		const tmp = join(VENDOR, `_extract-${PINS.pyodide}`);
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		execFileSync("tar", ["-xjf", tarball, "-C", tmp], { stdio: "inherit" });
		// The tarball unpacks to a top-level "pyodide/" dir.
		rmSync(PYODIDE_DIR, { recursive: true, force: true });
		renameSync(join(tmp, "pyodide"), PYODIDE_DIR);
		rmSync(tmp, { recursive: true, force: true });
	}
	// Verify the platform-independent runtime bytes regardless of skip/extract.
	for (const name of ["pyodide.mjs", "pyodide.asm.wasm", "python_stdlib.zip"]) {
		verify(join(PYODIDE_DIR, name), name);
	}
}

function fetchWheels() {
	mkdirSync(PYODIDE_DIR, { recursive: true });
	for (const wheel of [PINS.etXmlfileWheel, PINS.openpyxlWheel]) {
		const dest = join(PYODIDE_DIR, wheel);
		if (existsSync(dest) && sha256(dest) === SHA256[wheel]) {
			log(`${wheel} already present`);
			continue;
		}
		log(`downloading ${wheel}…`);
		curl(WHEEL_URLS[wheel], dest);
		verify(dest, wheel);
	}
}

mkdirSync(VENDOR, { recursive: true });
fetchDeno();
fetchPyodide();
fetchWheels();
log(`done — vendor/ populated (deno=${PINS.deno}, pyodide=${PINS.pyodide})`);
