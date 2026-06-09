#!/usr/bin/env node
/**
 * Produce vendor/pyodide/pyodide-lock.custom.json — the stock Pyodide lock
 * augmented with the two vendored pure-python packages (openpyxl + et_xmlfile)
 * that the distribution omits. Run after fetch-pyodide-assets.mjs.
 *
 * MECHANISM (deliberate deviation from the plan's "micropip.freeze", per Phase 0
 * Discoveries' "do one or the other deliberately"): a DETERMINISTIC, fully
 * offline MERGE — read the stock lock, append entries for the two wheels (name /
 * version parsed from the filename, sha256 computed from the file), write the
 * custom lock. This is more robust than running micropip.freeze offline and
 * produces an equivalent artifact: a lock in which `loadPackage(["openpyxl"])`
 * resolves by name.
 *
 * This lock is SUPPLEMENTARY. runner.ts deliberately loads numpy/pandas/scipy by
 * name from the STOCK lock and openpyxl/et_xmlfile by direct file:// URL — the
 * spike-S1-proven offline path — so it does NOT depend on this custom lock. The
 * custom lock is a canonical dependency manifest and a future path to
 * loadPackage-by-name. NEVER hand-edit it; regenerate via this script.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIR = process.env.PYODIDE_ASSET_DIR ?? join(ROOT, "vendor", "pyodide");
const STOCK_LOCK = join(ASSET_DIR, "pyodide-lock.json");
const CUSTOM_LOCK = join(ASSET_DIR, "pyodide-lock.custom.json");

function log(msg) {
	console.error(`[build-pyodide-lock] ${msg}`);
}

if (!existsSync(STOCK_LOCK)) {
	throw new Error(`stock lock not found at ${STOCK_LOCK} — run scripts/fetch-pyodide-assets.mjs first`);
}

// The two pure-python packages absent from the distribution, with their
// dependency edges and import names (deterministic — known set).
const VENDORED = {
	et_xmlfile: { match: /^et_xmlfile-.*\.whl$/, imports: ["et_xmlfile"], depends: [] },
	openpyxl: { match: /^openpyxl-.*\.whl$/, imports: ["openpyxl"], depends: ["et_xmlfile"] },
};

function findWheel(re) {
	const hit = readdirSync(ASSET_DIR).find((f) => re.test(f));
	if (!hit) throw new Error(`wheel matching ${re} not found in ${ASSET_DIR} — run fetch-pyodide-assets.mjs`);
	return hit;
}

function parseNameVersion(fileName) {
	// PEP 427 wheel: {name}-{version}-{pytag}-{abitag}-{platformtag}.whl
	const [name, version] = fileName.split("-");
	if (!name || !version) {
		throw new Error(`malformed wheel filename (expected {name}-{version}-…): ${fileName}`);
	}
	return { name, version };
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const lock = JSON.parse(readFileSync(STOCK_LOCK, "utf8"));

for (const [key, spec] of Object.entries(VENDORED)) {
	const fileName = findWheel(spec.match);
	const { version } = parseNameVersion(fileName);
	lock.packages[key] = {
		name: key,
		version,
		file_name: fileName,
		install_dir: "site",
		sha256: sha256(join(ASSET_DIR, fileName)),
		package_type: "package",
		imports: spec.imports,
		depends: spec.depends,
		unvendored_tests: false,
		shared_library: false,
	};
	log(`added ${key}@${version} (${fileName})`);
}

writeFileSync(CUSTOM_LOCK, `${JSON.stringify(lock, null, 1)}\n`);
log(`wrote ${CUSTOM_LOCK} (${Object.keys(lock.packages).length} packages)`);
