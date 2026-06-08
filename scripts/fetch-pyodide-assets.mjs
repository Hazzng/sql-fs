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
 * and the two pure-python wheels). The Deno binary is pinned by version + the
 * official dl.deno.land URL only — its bytes are platform-specific, so a single
 * cross-arch checksum is impossible; we verify it extracted and is executable.
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
	"pyodide.mjs": "c8dffeefeb6f9c4bf635baf0cdb51f4da06df0e3aab4fe1a99b8ad3570065461",
	"pyodide.asm.wasm": "10090fe41e019ae669d512e1f747021a8db2aaab0f6dd6f85fa9368c55d681e3",
	"python_stdlib.zip": "92cb24faa546818f3ef4050fd5bd2b6487bd2042efed2113af141d035f30efb4",
	[PINS.openpyxlWheel]: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
	[PINS.etXmlfileWheel]: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
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

function fetchDeno() {
	if (existsSync(DENO_BIN)) {
		log(`Deno ${PINS.deno} already present`);
		return;
	}
	const target = denoTarget();
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
