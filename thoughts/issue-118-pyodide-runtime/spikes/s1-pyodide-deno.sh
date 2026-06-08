#!/usr/bin/env bash
# Spike S1 — Pyodide-on-Deno offline (gates Phase 3).
#
# Bootstraps a PINNED Deno binary + the PINNED Pyodide full distribution into
# ./assets/ (cached; re-runs skip downloads), then runs s1_runner.ts under the
# EXACT committed deny-belt flags from design.md Decision 1. A successful run
# under --deny-net is the proof of zero network access.
#
# Usage:  bash s1-pyodide-deno.sh
# Exit 0  => round-trip byte length printed, zero-network confirmed.

set -euo pipefail

# --- Pinned versions (must match what Phase 3 pins) -------------------------
DENO_VERSION="v2.8.2"
PYODIDE_VERSION="0.29.4"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="${SCRIPT_DIR}/assets"
DENO_DIR="${ASSETS}/deno-${DENO_VERSION}"
DENO_BIN="${DENO_DIR}/deno"
PYODIDE_DIR="${ASSETS}/pyodide-${PYODIDE_VERSION}"   # extracted dist root (contains pyodide.mjs)
mkdir -p "${ASSETS}"

# --- Resolve Deno download target for this host -----------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
case "${OS}-${ARCH}" in
	Darwin-arm64)  DENO_TARGET="aarch64-apple-darwin" ;;
	Darwin-x86_64) DENO_TARGET="x86_64-apple-darwin" ;;
	Linux-aarch64) DENO_TARGET="aarch64-unknown-linux-gnu" ;;
	Linux-x86_64)  DENO_TARGET="x86_64-unknown-linux-gnu" ;;
	*) echo "S1 FAIL: unsupported host ${OS}-${ARCH}" >&2; exit 2 ;;
esac

# --- 1. Fetch pinned Deno (cached) ------------------------------------------
if [[ ! -x "${DENO_BIN}" ]]; then
	echo "[s1] downloading Deno ${DENO_VERSION} (${DENO_TARGET})…" >&2
	mkdir -p "${DENO_DIR}"
	deno_zip="${DENO_DIR}/deno.zip"
	curl -fSL -o "${deno_zip}" \
		"https://dl.deno.land/release/${DENO_VERSION}/deno-${DENO_TARGET}.zip"
	unzip -oq "${deno_zip}" -d "${DENO_DIR}"
	rm -f "${deno_zip}"
	chmod +x "${DENO_BIN}"
	# Strip any quarantine xattr (no-op on Linux / when absent).
	xattr -d com.apple.quarantine "${DENO_BIN}" 2>/dev/null || true
else
	echo "[s1] Deno ${DENO_VERSION} already present" >&2
fi
echo "[s1] deno version: $("${DENO_BIN}" --version | head -1)" >&2

# --- 2. Fetch + extract pinned Pyodide full distribution (cached) -----------
if [[ ! -f "${PYODIDE_DIR}/pyodide.mjs" ]]; then
	echo "[s1] downloading Pyodide ${PYODIDE_VERSION} full distribution (~408 MB)…" >&2
	tarball="${ASSETS}/pyodide-${PYODIDE_VERSION}.tar.bz2"
	if [[ ! -f "${tarball}" ]]; then
		curl -fSL -o "${tarball}" \
			"https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-${PYODIDE_VERSION}.tar.bz2"
	fi
	echo "[s1] extracting…" >&2
	tmp_extract="${ASSETS}/_extract-${PYODIDE_VERSION}"
	rm -rf "${tmp_extract}"; mkdir -p "${tmp_extract}"
	tar -xjf "${tarball}" -C "${tmp_extract}"
	# The tarball unpacks to a top-level "pyodide/" dir.
	rm -rf "${PYODIDE_DIR}"
	mv "${tmp_extract}/pyodide" "${PYODIDE_DIR}"
	rm -rf "${tmp_extract}" "${tarball}"
else
	echo "[s1] Pyodide ${PYODIDE_VERSION} already extracted" >&2
fi
echo "[s1] pyodide assets: $(ls "${PYODIDE_DIR}" | wc -l | tr -d ' ') files in ${PYODIDE_DIR}" >&2

# --- 2b. Vendor openpyxl + et_xmlfile wheels (NOT in the pyodide dist) -------
# FINDING (gates Phase 3): openpyxl + et_xmlfile are absent from pyodide
# 0.29.4's distribution + pyodide-lock.json. Both are PURE-PYTHON wheels; we
# vendor pinned copies into the asset dir (cached) so the round-trip is fully
# offline. Phase 3/7 must bake these the same way and generate a custom lock
# (micropip.freeze) rather than relying on the stock distribution.
OPENPYXL_WHL="openpyxl-3.1.5-py2.py3-none-any.whl"
ETXML_WHL="et_xmlfile-2.0.0-py3-none-any.whl"
OPENPYXL_URL="https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/${OPENPYXL_WHL}"
ETXML_URL="https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/${ETXML_WHL}"
for pair in "${ETXML_WHL}|${ETXML_URL}" "${OPENPYXL_WHL}|${OPENPYXL_URL}"; do
	whl="${pair%%|*}"; url="${pair#*|}"
	if [[ ! -f "${PYODIDE_DIR}/${whl}" ]]; then
		echo "[s1] vendoring ${whl}…" >&2
		curl -fSL --no-progress-meter -o "${PYODIDE_DIR}/${whl}" "${url}"
	fi
done

# --- 3. Run under the EXACT committed deny-belt -----------------------------
# DENO_NO_UPDATE_CHECK is read by the Deno runtime from the spawn env (NOT via
# Deno.env, which --deny-env blocks). The asset dir is passed as ARGV.
echo "[s1] running s1_runner.ts under the committed deny-belt…" >&2
DENO_NO_UPDATE_CHECK=1 "${DENO_BIN}" run \
	--no-prompt \
	--deny-net --deny-run --deny-write --deny-env --deny-ffi --deny-sys --deny-import \
	--no-remote --no-npm --cached-only --no-config \
	--allow-read="${PYODIDE_DIR}" \
	"${SCRIPT_DIR}/s1_runner.ts" "${PYODIDE_DIR}" "${ETXML_WHL}" "${OPENPYXL_WHL}"
