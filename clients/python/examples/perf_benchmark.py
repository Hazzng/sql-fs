"""Comprehensive performance benchmark for the VirtualFS API + Python SDK.

Exercises every hot path users actually care about:

  1. auth       — JWT bootstrap latency
  2. lifecycle  — sandbox create / get / delete round-trips
  3. single     — single-file write / read (cold cache vs warm)
  4. ingest     — same N-file payload via three methods, side-by-side:
                    per-file `fs.write`, `fs.write_files`, `ingest_files`
  5. tree       — `fs.tree()` at depth 1 / 3 / unlimited
  6. exec       — echo overhead distribution (p50/p95) + batch speedup curve
  7. cache      — pathCache vs contentCache: `find` vs `grep -r NOMATCH`
                    cold/warm/repeat — quantifies the "first content scan" tax
  8. export     — tar.gz download time + size

Usage:
    BASE_URL=...  AUTH_SECRET=...  python perf_benchmark.py
    BASE_URL=... AUTH_SECRET=... python perf_benchmark.py --folder /path/to/code
    BASE_URL=... AUTH_SECRET=... python perf_benchmark.py --json out.json
    BASE_URL=... AUTH_SECRET=... python perf_benchmark.py --skip exec,cache
    BASE_URL=... AUTH_SECRET=... python perf_benchmark.py --files 50 --file-size 4096

Default dataset is a synthetic 100-file / ~1 MB tree. Pass `--folder` to walk a
real codebase instead — file count + total size are reported either way so
results are comparable.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from virtualfs import (
    Client,
    NotFoundError,
    Sandbox,
    __version__,
)

SANDBOX_BASE = "/home/user/bench"
SKIP_DIRS = {"__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", "node_modules"}
SKIP_SUFFIXES = {".pyc", ".pyo"}


# ── result rows ──────────────────────────────────────────────────────────────
@dataclass
class Row:
    section: str
    label: str
    ms: Optional[float] = None
    throughput_kbs: Optional[float] = None
    note: str = ""
    error: Optional[str] = None
    extra: dict = field(default_factory=dict)


# ── helpers ──────────────────────────────────────────────────────────────────
def fmt_ms(ms: Optional[float]) -> str:
    if ms is None:
        return "       -"
    return f"{ms:>8,.0f}"


def fmt_throughput(kbs: Optional[float]) -> str:
    if kbs is None:
        return "         "
    if kbs >= 1024:
        return f"{kbs / 1024:>6.1f} MB/s"
    return f"{kbs:>6.0f} KB/s"


def time_call(fn: Callable[[], Any]) -> tuple[float, Any]:
    t = time.perf_counter()
    out = fn()
    return (time.perf_counter() - t) * 1000, out


def synth_dataset(count: int, avg_size: int) -> dict[str, bytes]:
    """Generate a synthetic Python-ish source tree.

    Files are ~`avg_size` bytes of valid Python text containing identifiable
    patterns (`class`, `def`, `TODO`) so the cache section produces realistic
    grep match counts.
    """
    files: dict[str, bytes] = {}
    body_unit = (
        "def helper_{i}(x: int) -> int:\n"
        "    \"\"\"TODO: tighten input validation.\"\"\"\n"
        "    return x * {i} + {i}\n\n"
        "class Widget_{i}:\n"
        "    name = 'widget-{i}'\n"
        "    def shape(self) -> str:\n"
        "        return self.name\n\n"
    )
    for i in range(count):
        # Compose enough body_units to approximate avg_size.
        unit = body_unit.format(i=i).encode()
        repeats = max(1, avg_size // len(unit))
        path = f"pkg/mod_{i // 10}/file_{i:03d}.py"
        files[path] = unit * repeats
    return files


def collect_folder(root: Path) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for p in root.rglob("*"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.suffix in SKIP_SUFFIXES or p.name == ".DS_Store":
            continue
        if p.is_file():
            out[p.relative_to(root).as_posix()] = p.read_bytes()
    return out


def percentile(samples: list[float], p: float) -> float:
    """Compute the p-th percentile (0–100) using nearest-rank."""
    if not samples:
        return float("nan")
    s = sorted(samples)
    idx = max(0, min(len(s) - 1, int(round(p / 100.0 * (len(s) - 1)))))
    return s[idx]


# ── sections ─────────────────────────────────────────────────────────────────
def bench_auth(rows: list[Row], base_url: str, auth_secret: str, sub: str) -> Client:
    """Mints a fresh JWT and returns the connected client. Times the bootstrap."""
    print("\n[1/8] auth — bootstrapping JWT ...")
    t = time.perf_counter()
    c = Client(base_url=base_url, auth_secret=auth_secret, sub=sub)
    _ = c.token  # forces bootstrap
    rows.append(Row("auth", "bootstrap (X-Auth-Secret → JWT)", ms=(time.perf_counter() - t) * 1000))
    return c


def bench_lifecycle(rows: list[Row], client: Client) -> str:
    print("[2/8] lifecycle — create / get / delete ...")
    ms_create, sb = time_call(lambda: client.sandboxes.create(name="bench-lifecycle"))
    rows.append(Row("lifecycle", "sandboxes.create", ms=ms_create))
    sb_id = sb.id
    ms_get, _ = time_call(lambda: client.sandboxes.get(sb_id))
    rows.append(Row("lifecycle", "sandboxes.get", ms=ms_get))
    ms_del, _ = time_call(lambda: client.sandboxes.delete(sb_id))
    rows.append(Row("lifecycle", "sandboxes.delete (empty)", ms=ms_del))
    # Return a fresh sandbox for downstream sections so we don't reuse this one.
    return ""  # consumed inline


def bench_single(rows: list[Row], sb: Sandbox) -> None:
    print("[3/8] single-file ops — write / read cold / read warm ...")
    payload = ("hello, world!\n" * 64).encode()  # ~896 B
    ms_write, _ = time_call(lambda: sb.fs.write("/home/user/single.txt", payload))
    rows.append(Row("single", "fs.write (1 KB)", ms=ms_write))
    ms_cold, _ = time_call(lambda: sb.fs.read("/home/user/single.txt"))
    rows.append(Row("single", "fs.read (cold cache)", ms=ms_cold))
    ms_warm, _ = time_call(lambda: sb.fs.read("/home/user/single.txt"))
    rows.append(Row("single", "fs.read (warm cache)", ms=ms_warm))


def bench_ingest(
    rows: list[Row],
    client: Client,
    files: dict[str, bytes],
) -> None:
    """Compare three ways to upload the same payload.

    Each method runs in its own fresh sandbox so cache state and DB inode
    counts don't bleed across. The smallest sample (per-file fs.write) is
    capped to keep the benchmark from blocking — the round-trip count makes
    its true throughput obvious from a small sample.
    """
    total_bytes = sum(len(v) for v in files.values())
    n = len(files)
    print(f"[4/8] ingest — comparing 3 methods on {n} files / {total_bytes:,} B ...")

    # 4a: per-file fs.write — quadratic in N round-trips. Capped to PERFILE_CAP
    # so the benchmark stays bounded; we extrapolate to "estimated full" too.
    PERFILE_CAP = min(20, n)
    sub_files = list(files.items())[:PERFILE_CAP]
    sub_bytes = sum(len(v) for _, v in sub_files)
    sb = client.sandboxes.create(name="bench-ingest-perfile")
    try:
        t = time.perf_counter()
        for path, content in sub_files:
            sb.fs.write(f"{SANDBOX_BASE}/{path}", content)
        ms = (time.perf_counter() - t) * 1000
        kbs = (sub_bytes / 1024) / (ms / 1000) if ms > 0 else None
        per_file_ms = ms / PERFILE_CAP
        rows.append(
            Row(
                "ingest",
                f"per-file fs.write × {PERFILE_CAP}  ({sub_bytes:,} B)",
                ms=ms,
                throughput_kbs=kbs,
                note=f"~{per_file_ms:.0f} ms/file → est. {per_file_ms * n / 1000:.1f} s for full {n}",
            )
        )
    finally:
        client.sandboxes.delete(sb.id)

    # 4b: fs.write_files — single round-trip, plain JSON (UTF-8 text only).
    text_only = {f"{SANDBOX_BASE}/{p}": v.decode("utf-8", errors="replace") for p, v in files.items()}
    sb = client.sandboxes.create(name="bench-ingest-writefiles")
    try:
        ms, _ = time_call(lambda: sb.fs.write_files(text_only))
        kbs = (total_bytes / 1024) / (ms / 1000) if ms > 0 else None
        rows.append(
            Row("ingest", f"fs.write_files (1 RTT, JSON)  [{n} files]", ms=ms, throughput_kbs=kbs)
        )
    finally:
        client.sandboxes.delete(sb.id)

    # 4c: ingest_files — single round-trip, base64 JSON (~33% wire overhead but binary-safe).
    sb = client.sandboxes.create(name="bench-ingest-base64")
    try:
        ms, _ = time_call(lambda: sb.ingest_files(files, base_path=SANDBOX_BASE))
        kbs = (total_bytes / 1024) / (ms / 1000) if ms > 0 else None
        rows.append(
            Row("ingest", f"ingest_files (1 RTT, base64)  [{n} files]", ms=ms, throughput_kbs=kbs)
        )
    finally:
        # Keep this one — it'll be the dataset for tree/exec/cache/export.
        pass

    # We deliberately leak the third sandbox out via a side channel so
    # subsequent sections can reuse it. Return via attribute on rows list
    # would be ugly; use a sentinel row carrying the id.
    rows.append(Row("__internal__", "ingest_sandbox_id", note=sb.id, extra={"id": sb.id}))


def _pop_ingest_sandbox_id(rows: list[Row]) -> Optional[str]:
    for row in list(rows):
        if row.section == "__internal__" and row.label == "ingest_sandbox_id":
            rows.remove(row)
            return row.extra.get("id")
    return None


def bench_tree(rows: list[Row], sb: Sandbox) -> None:
    print("[5/8] tree — depth 1 / 3 / unlimited ...")
    for depth in (1, 3, None):
        label = f"fs.tree(depth={depth if depth else 'unlimited'})"
        ms, entries = time_call(lambda d=depth: sb.fs.tree(prefix=SANDBOX_BASE, depth=d))
        rows.append(Row("tree", label, ms=ms, note=f"{len(entries)} entries"))


def bench_exec(rows: list[Row], sb: Sandbox) -> None:
    print("[6/8] exec — echo distribution + batch speedup ...")

    # Steady-state echo overhead: 12 samples after 3 warmups.
    for _ in range(3):
        sb.exec(":", timeout_ms=5000)
    samples: list[float] = []
    for _ in range(12):
        t = time.perf_counter()
        sb.exec(":", timeout_ms=5000)
        samples.append((time.perf_counter() - t) * 1000)
    rows.append(
        Row(
            "exec",
            "exec(':') × 12 — p50",
            ms=percentile(samples, 50),
            extra={"samples_ms": samples},
        )
    )
    rows.append(Row("exec", "exec(':') — p95", ms=percentile(samples, 95)))
    rows.append(Row("exec", "exec(':') — max", ms=max(samples)))

    # Batch speedup curve: same trivial script, varying count.
    for n in (5, 20, 50):
        scripts = [{"id": f"s{i}", "script": "echo hi > /dev/null"} for i in range(n)]
        ms, _ = time_call(lambda s=scripts: sb.exec_batch(s, timeout_ms=30_000))
        rows.append(
            Row(
                "exec",
                f"exec_batch × {n}",
                ms=ms,
                note=f"avg {ms / n:.1f} ms/script (vs {percentile(samples, 50):.0f} ms each individually)",
            )
        )


def bench_cache(rows: list[Row], sb: Sandbox) -> None:
    print("[7/8] cache — pathCache vs contentCache ...")
    find_cmd = f"find {SANDBOX_BASE} -type f | wc -l"
    grep_nomatch = f"grep -rn 'ZZZ_NEVER_MATCHES_ZZZ' {SANDBOX_BASE} 2>/dev/null | wc -l"
    grep_with_pipe = f"grep -rn 'class ' {SANDBOX_BASE} 2>/dev/null | head -15"

    # Metadata-only command: pathCache hit, no DB content fetch.
    ms, r = time_call(lambda: sb.exec(find_cmd, timeout_ms=15_000))
    rows.append(
        Row("cache", "find -type f | wc -l", ms=ms, note=f"{r.stdout.strip()} files (pathCache only)")
    )

    # First content scan — cold contentCache: 1 SQL roundtrip per blob.
    ms_cold, _ = time_call(lambda: sb.exec(grep_nomatch, timeout_ms=60_000))
    rows.append(Row("cache", "grep -r NOMATCH (cold contentCache)", ms=ms_cold))

    # Same command — should be hot now.
    ms_w1, _ = time_call(lambda: sb.exec(grep_nomatch, timeout_ms=60_000))
    rows.append(Row("cache", "grep -r NOMATCH (warm 1)", ms=ms_w1))

    # Same command, third pass — confirms steady-state IFS floor.
    ms_w2, _ = time_call(lambda: sb.exec(grep_nomatch, timeout_ms=60_000))
    rows.append(
        Row(
            "cache",
            "grep -r NOMATCH (warm 2)",
            ms=ms_w2,
            note=f"cold tax = {ms_cold - ms_w2:.0f} ms; IFS floor = {ms_w2:.0f} ms",
        )
    )

    # SIGPIPE early-exit demonstration — head closes the pipe after N matches.
    ms_pipe, r = time_call(lambda: sb.exec(grep_with_pipe, timeout_ms=15_000))
    rows.append(
        Row(
            "cache",
            "grep -r 'class ' | head -15",
            ms=ms_pipe,
            note=f"{len(r.stdout.splitlines())} lines — early exit via SIGPIPE",
        )
    )


def bench_export(rows: list[Row], sb: Sandbox) -> None:
    print("[8/8] export — tar.gz download ...")
    ms, blob = time_call(lambda: sb.export(base_path=SANDBOX_BASE))
    kbs = (len(blob) / 1024) / (ms / 1000) if ms > 0 else None
    rows.append(
        Row(
            "export",
            "sb.export() — full tree as .tar.gz",
            ms=ms,
            throughput_kbs=kbs,
            note=f"{len(blob):,} B archive",
        )
    )


# ── output ───────────────────────────────────────────────────────────────────
SECTION_TITLES = {
    "auth": "1. Auth",
    "lifecycle": "2. Sandbox lifecycle",
    "single": "3. Single-file ops",
    "ingest": "4. Bulk ingest comparison",
    "tree": "5. Tree listing",
    "exec": "6. Exec overhead + batch speedup",
    "cache": "7. Cache behaviour (pathCache vs contentCache)",
    "export": "8. Export (tar.gz)",
}


def render_table(rows: list[Row]) -> str:
    out: list[str] = []
    by_section: dict[str, list[Row]] = {}
    for r in rows:
        if r.section.startswith("__"):
            continue
        by_section.setdefault(r.section, []).append(r)

    for section, items in by_section.items():
        title = SECTION_TITLES.get(section, section)
        out.append(f"\n── {title} " + "─" * max(0, 70 - len(title)))
        for r in items:
            label = r.label.ljust(46)[:46]
            ms = fmt_ms(r.ms)
            tput = fmt_throughput(r.throughput_kbs)
            line = f"  {label}  {ms} ms  {tput}"
            if r.note:
                line += f"   {r.note}"
            if r.error:
                line += f"   ERROR: {r.error}"
            out.append(line)
    return "\n".join(out)


# ── main ─────────────────────────────────────────────────────────────────────
def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--folder",
        type=Path,
        help="Use a real folder for the ingest dataset (default: synthetic)",
    )
    parser.add_argument("--files", type=int, default=100, help="synthetic file count (default: 100)")
    parser.add_argument(
        "--file-size", type=int, default=10 * 1024, help="synthetic avg file size in bytes (default: 10240)"
    )
    parser.add_argument("--json", type=Path, help="also write results as JSON to PATH")
    parser.add_argument(
        "--skip",
        type=str,
        default="",
        help="comma-separated section ids to skip (auth,lifecycle,single,ingest,tree,exec,cache,export)",
    )
    parser.add_argument("--sub", type=str, default="bench-runner", help="JWT subject (default: bench-runner)")
    args = parser.parse_args(argv)

    base_url = os.environ.get("BASE_URL")
    auth_secret = os.environ.get("AUTH_SECRET")
    token = os.environ.get("TOKEN")
    if not base_url or not (auth_secret or token):
        print("ERROR: set BASE_URL and either AUTH_SECRET or TOKEN", file=sys.stderr)
        return 2

    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    print(f"virtualfs-python {__version__}  →  {base_url}")
    print(f"skip={sorted(skip) or 'none'}")

    if args.folder:
        if not args.folder.is_dir():
            print(f"ERROR: --folder {args.folder} is not a directory", file=sys.stderr)
            return 2
        print(f"dataset: walking {args.folder} ...")
        files = collect_folder(args.folder)
    else:
        print(f"dataset: synthetic {args.files} files × ~{args.file_size} B ...")
        files = synth_dataset(args.files, args.file_size)
    total_bytes = sum(len(v) for v in files.values())
    print(f"  {len(files)} files, {total_bytes:,} bytes")

    rows: list[Row] = []
    rows.append(
        Row(
            "__meta__",
            "dataset",
            note=f"{len(files)} files, {total_bytes:,} bytes",
            extra={"files": len(files), "bytes": total_bytes, "source": str(args.folder) if args.folder else "synthetic"},
        )
    )

    client: Optional[Client] = None
    sb: Optional[Sandbox] = None
    sb_id: Optional[str] = None
    try:
        if "auth" not in skip:
            client = bench_auth(rows, base_url, auth_secret or "", args.sub)
        else:
            client = Client(base_url=base_url, auth_secret=auth_secret, token=token, sub=args.sub)

        if "lifecycle" not in skip:
            bench_lifecycle(rows, client)

        if "single" not in skip:
            sb = client.sandboxes.create(name="bench-single")
            try:
                bench_single(rows, sb)
            finally:
                client.sandboxes.delete(sb.id)
                sb = None

        if "ingest" not in skip:
            bench_ingest(rows, client, files)
            sb_id = _pop_ingest_sandbox_id(rows)
            if sb_id:
                sb = client.sandboxes.attach(sb_id)
        else:
            # Need a populated sandbox for tree/exec/cache/export sections.
            sb = client.sandboxes.create(name="bench-fallback")
            sb.ingest_files(files, base_path=SANDBOX_BASE)
            sb_id = sb.id

        if sb is not None:
            try:
                if "tree" not in skip:
                    bench_tree(rows, sb)
                if "exec" not in skip:
                    bench_exec(rows, sb)
                if "cache" not in skip:
                    bench_cache(rows, sb)
                if "export" not in skip:
                    bench_export(rows, sb)
            finally:
                if sb_id:
                    try:
                        client.sandboxes.delete(sb_id)
                    except (NotFoundError, Exception) as e:
                        rows.append(Row("__cleanup__", "delete final sandbox", error=str(e)))

    finally:
        if client is not None:
            client.close()

    print(render_table(rows))

    if args.json:
        payload = {
            "sdk_version": __version__,
            "base_url": base_url,
            "rows": [asdict(r) for r in rows if not r.section.startswith("__")],
            "meta": {
                "dataset_files": len(files),
                "dataset_bytes": total_bytes,
                "dataset_source": str(args.folder) if args.folder else "synthetic",
            },
        }
        args.json.write_text(json.dumps(payload, indent=2))
        print(f"\nwrote JSON results to {args.json}")

    # Surface hidden cleanup errors so they're visible (render_table hides
    # __internal__/__cleanup__ rows) but don't fail the run on them — the
    # benchmark itself succeeded.
    cleanup_errors = [r for r in rows if r.section.startswith("__") and r.error]
    for r in cleanup_errors:
        print(f"[cleanup warning] {r.label}: {r.error}", file=sys.stderr)

    bench_errors = [r for r in rows if not r.section.startswith("__") and r.error]
    return 1 if bench_errors else 0


if __name__ == "__main__":
    sys.exit(main())
