# S3 — Per-child memory behavior (gates Phase 6)

## GATE: ✅ PASS

`s3-memory.sh` exits **0** and confirms the operating model in design.md
Decision 5: as the non-root `node` user in `node:22-slim`, **per-child memory
limiting is unavailable/unusable**, so the **operator-set container memory limit
+ accepted availability risk is the guard**.

```text
cgroup_write_denied=1 rlimit_as_unusable=1 (vaddr_decoupled=1 rlimit_breaks_wasm=1)
S3 PASS: non-root cannot set cgroup memory.max; prlimit --as is unusable for RSS
         (V8/WASM vaddr >> RSS). Container memory limit is the real guard.
```

(Run in a real Linux container because the host is macOS — cgroup v2 and the V8
virtual-address-space semantics only exist Linux-side, which is the prod target.)

## Probe 1 — cgroup v2 `memory.max` write: DENIED (expected)

As uid 1000 (`node`) with the default Docker cgroup mount:
- `echo … > /sys/fs/cgroup/memory.max` → **Read-only file system** (denied).
- `mkdir /sys/fs/cgroup/s3probe` (child cgroup) → **Read-only file system** (denied).

The cgroup v2 hierarchy is mounted **read-only** for the unprivileged container,
so a non-root (and indeed any in-container) process cannot set a per-child
`memory.max`. Confirms: no per-child cgroup memory cap without `--privileged` /
host cgroup delegation, which this deployment does not assume.

## Probe 2 — `prlimit --as` / `ulimit -v` (RLIMIT_AS): UNUSABLE for RSS (expected)

RLIMIT_AS caps **virtual** address space, not **resident** memory, and V8 + a
WASM heap reserve enormous virtual space while staying tiny resident:

- **(2a)** Creating `WebAssembly.Memory({initial:16, maximum:32768})` (~2 GiB max,
  Pyodide-like) → **VmSize ≈ 10,712 MB** but **VmRSS ≈ 41 MB**. The virtual
  reservation is ~260× the resident size — RLIMIT_AS cannot track RSS.
- **(2b)** Under `ulimit -v 2097152` (2 GiB — a limit that *would* be a useful RSS
  cap), the same allocation **fails**: `RangeError: WebAssembly.Memory(): could
  not allocate memory`. So any RLIMIT_AS low enough to bound RSS **breaks the
  workload**, and any value letting it run (≥ ~10.7 GiB here) is far too high to
  bound RSS. ⇒ unusable as a per-child RAM cap.

## Operating model for Phase 6 (carry forward)

- **Do NOT** attempt per-child `cgroup memory.max` or `prlimit --as` as the RAM
  guard — both are confirmed unavailable/unusable in this posture.
- The **container memory limit** covers Node + **all** Deno children together.
  Operators size it as `MAX_RESIDENT_PYODIDE × per-proc ceiling` (`MAX_RESIDENT=1`
  on small hosts). A runaway child can OOM-kill the whole container — **accepted
  availability risk** (Decision 5), mitigated by multi-replica + restart.
- Phase 6's manager must **report an error + respawn (new generation) on child
  exit** (including OOM-kill), since it cannot prevent the OOM itself.
- The Pyodide ~2 GiB WASM cap is only a per-instance **heap** ceiling — note the
  full process vaddr reservation is ~5× that (~10 GiB here), but RSS is what the
  container limit actually constrains.

## Notable

- The `bash: …memory.max: Read-only file system` line is the shell's own redirect
  error (emitted before the command runs, so not captured by `2>/tmp/cgerr`);
  it is cosmetic and corroborates the denial — the probe still classifies it
  correctly.
- cgroup controllers present in-container: `cpuset cpu io memory hugetlb pids rdma`
  (so cgroup v2 with the memory controller **is** active — the limit just isn't
  writable by the container).
