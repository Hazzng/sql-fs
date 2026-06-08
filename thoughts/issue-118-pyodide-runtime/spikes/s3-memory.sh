#!/usr/bin/env bash
# Spike S3 — Per-child memory behavior (gates Phase 6).
#
# Confirms the operating model in design.md Decision 5: on `node:22-slim` as the
# non-root `node` user, per-PROCESS memory limiting is NOT reliably available, so
# the OPERATOR-SET CONTAINER MEMORY LIMIT + accepted availability risk is the
# guard — NOT per-child cgroup `memory.max` or `prlimit --as`.
#
# Runs inside a real Linux container (this host is macOS; the cgroup v2 / V8
# vaddr semantics only exist in the Linux container — exactly the prod target):
#
#   Probe 1 — cgroup v2 memory.max write: a non-root user attempts to write
#             memory.max / create a child cgroup. EXPECTED: denied (read-only fs).
#   Probe 2 — RLIMIT_AS (== `prlimit --as` / `ulimit -v`) caps VIRTUAL address
#             space, not RSS. V8 + a WASM heap (Pyodide's model) RESERVE a huge
#             virtual region while resident memory stays tiny, so:
#               (2a) VmSize >> VmRSS — the limit cannot track real RSS; and
#               (2b) an RLIMIT_AS low enough to bound RSS (2 GiB) makes the WASM
#                    reservation FAIL — the workload can't even start.
#             => RLIMIT_AS / prlimit --as is unusable as a per-child RAM cap.
#
# Exit 0 => both probes confirm the EXPECTED (limiting unavailable/unusable).
# Exit 1 => a probe behaved unexpectedly (Decision 5 would need revisiting).

set -euo pipefail

IMAGE="node:22-slim"

if ! command -v docker >/dev/null 2>&1; then
	echo "S3 FAIL: docker not available — required to exercise Linux cgroup v2 / V8 vaddr semantics" >&2
	exit 2
fi

echo "[s3] pulling ${IMAGE} if needed…" >&2
docker pull -q "${IMAGE}" >/dev/null

# In-container probe. Runs as the image's built-in non-root `node` user (uid 1000)
# with the default Docker cgroup mount (read-only for unprivileged containers —
# exactly the prod posture).
read -r -d '' PROBE <<'PROBE_EOF' || true
set -u
echo "=== identity ==="
id
echo "=== cgroup controllers ==="
cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo "(no unified cgroup.controllers)"

echo "=== PROBE 1: write cgroup v2 memory.max as non-root ==="
MEMMAX_DENIED=0
if [ -e /sys/fs/cgroup/memory.max ]; then
	CUR="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo '?')"
	if echo 104857600 > /sys/fs/cgroup/memory.max 2>/tmp/cgerr; then
		echo "RESULT: memory.max write SUCCEEDED (unexpected)"
	else
		echo "RESULT: memory.max write DENIED (current=${CUR}) -> $(cat /tmp/cgerr 2>/dev/null)"
		MEMMAX_DENIED=1
	fi
else
	echo "memory.max not present at cgroup root"
fi
if mkdir /sys/fs/cgroup/s3probe 2>/tmp/cgmk; then
	echo "RESULT: child cgroup mkdir SUCCEEDED (unexpected)"; rmdir /sys/fs/cgroup/s3probe 2>/dev/null || true
else
	echo "RESULT: child cgroup mkdir DENIED -> $(cat /tmp/cgmk 2>/dev/null)"
	[ "$MEMMAX_DENIED" -eq 0 ] && MEMMAX_DENIED=1   # fall back to mkdir denial if memory.max was absent
fi

echo "=== PROBE 2: RLIMIT_AS (prlimit --as / ulimit -v) caps VIRTUAL memory, not RSS ==="
# 2a — V8 + a large-max WASM heap reserve vaddr >> RSS.
read VMSIZE VMRSS < <(node -e '
  const fs=require("fs");
  new WebAssembly.Memory({initial:16, maximum:32768});  // ~2 GiB max heap (Pyodide-like)
  const s=fs.readFileSync("/proc/self/status","utf8");
  const g=k=>Math.round(+(new RegExp(k+":\\s+(\\d+) kB").exec(s)[1])/1024);
  console.log(g("VmSize"), g("VmRSS"));
')
echo "RESULT(2a): with a large-max WASM heap -> VmSize=${VMSIZE:-?}MB VmRSS=${VMRSS:-?}MB"
VADDR_DECOUPLED=0
if [ "${VMSIZE:-0}" -gt 4096 ] && [ "${VMRSS:-999999}" -lt 512 ]; then
	echo "  => virtual reservation (${VMSIZE}MB) >> resident (${VMRSS}MB): RLIMIT_AS cannot track RSS"
	VADDR_DECOUPLED=1
fi

# 2b — an RLIMIT_AS low enough to be a useful RSS cap (2 GiB) BREAKS the reservation.
RLIMIT_BREAKS=0
( ulimit -v 2097152; node -e '
	try { new WebAssembly.Memory({initial:16, maximum:32768}); console.log("WASM_RESERVE_OK"); }
	catch (e) { console.log("WASM_RESERVE_FAILED: "+e.constructor.name+": "+e.message); process.exit(7); }
' ); RC=$?
if [ "$RC" -ne 0 ]; then
	echo "RESULT(2b): under 2 GiB RLIMIT_AS the WASM reservation FAILED (rc=$RC) => a limit usable for RSS breaks the workload"
	RLIMIT_BREAKS=1
else
	echo "RESULT(2b): WASM reserved under 2 GiB RLIMIT_AS (unexpected)"
fi

RLIMIT_UNUSABLE=0
[ "$VADDR_DECOUPLED" -eq 1 ] && [ "$RLIMIT_BREAKS" -eq 1 ] && RLIMIT_UNUSABLE=1

echo "=== SUMMARY ==="
echo "cgroup_write_denied=${MEMMAX_DENIED} rlimit_as_unusable=${RLIMIT_UNUSABLE} (vaddr_decoupled=${VADDR_DECOUPLED} rlimit_breaks_wasm=${RLIMIT_BREAKS})"
if [ "$MEMMAX_DENIED" -eq 1 ] && [ "$RLIMIT_UNUSABLE" -eq 1 ]; then
	echo "S3 PASS: non-root cannot set cgroup memory.max; prlimit --as is unusable for RSS (V8/WASM vaddr >> RSS). Container memory limit is the real guard."
	exit 0
fi
echo "S3 FAIL: a memory-limit probe behaved unexpectedly — revisit Decision 5"
exit 1
PROBE_EOF

docker run --rm --user node "${IMAGE}" bash -c "${PROBE}"
