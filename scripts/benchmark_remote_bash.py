#!/usr/bin/env python3
"""
Remote Bash latency benchmark.

Supports two providers:
  virtualfs  — VirtualFS HTTP API (default)
  daytona    — Daytona sandbox API

Measures:
  Phase 1 — Sandbox lifecycle: create / ingest / delete latency over N fresh
             sandboxes so every measurement includes a real round-trip.
  Phase 2 — Exec latency: grep / rg / find / write / delete / mv commands on a
             warm sandbox. Reports wall-clock ms (always) and server-reported
             duration_ms (VirtualFS only — Daytona does not expose this).

Usage:
  # VirtualFS (env-var defaults)
  API_URL=http://localhost:8080 AUTH_SECRET=dev \\
    python3 scripts/benchmark_remote_bash.py

  # Daytona
  python3 scripts/benchmark_remote_bash.py \\
    --provider daytona \\
    --daytona-api-key dtn_xxx \\
    --daytona-api-url https://app.daytona.io/api

  # Side-by-side (run twice, compare output)
  python3 scripts/benchmark_remote_bash.py --provider virtualfs ...
  python3 scripts/benchmark_remote_bash.py --provider daytona   ...
"""

from __future__ import annotations

import argparse
import math
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

# ── VirtualFS SDK (optional — only needed for virtualfs provider) ─────────────
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "clients" / "python" / "src"))

# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Remote Bash latency benchmark")
    p.add_argument(
        "--provider",
        choices=["virtualfs", "daytona"],
        default="virtualfs",
        help="Sandbox provider to benchmark (default: virtualfs)",
    )

    # VirtualFS args
    vfs = p.add_argument_group("VirtualFS provider")
    vfs.add_argument(
        "--api-url",
        default=os.environ.get("API_URL", "http://localhost:8080"),
        help="VirtualFS API base URL (default: $API_URL or http://localhost:8080)",
    )
    vfs.add_argument(
        "--auth-secret",
        default=os.environ.get("AUTH_SECRET"),
        help="Bootstrap secret (default: $AUTH_SECRET)",
    )
    vfs.add_argument("--sub", default="benchmark", help="JWT subject claim (default: benchmark)")

    # Daytona args
    dtn = p.add_argument_group("Daytona provider")
    dtn.add_argument(
        "--daytona-api-key",
        default=os.environ.get("DAYTONA_API_KEY"),
        help="Daytona API key (default: $DAYTONA_API_KEY)",
    )
    dtn.add_argument(
        "--daytona-api-url",
        default=os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api"),
        help="Daytona API URL (default: $DAYTONA_API_URL or https://app.daytona.io/api)",
    )

    # Common args
    p.add_argument(
        "--src-dir",
        default="./src",
        help="Local directory to ingest into the sandbox (default: ./src)",
    )
    p.add_argument(
        "--base-path",
        default="/home/user/src",
        help="Sandbox destination path (default: /home/user/src)",
    )
    p.add_argument(
        "--lifecycle-runs",
        type=int,
        default=3,
        help="Sandbox create/ingest/delete iterations (default: 3)",
    )
    p.add_argument("--warmup", type=int, default=1, help="Discarded exec warmup runs per case (default: 1)")
    p.add_argument("--runs", type=int, default=5, help="Measured exec runs per case (default: 5)")
    p.add_argument("--timeout-ms", type=int, default=60_000, help="Per-exec timeout ms (default: 60000)")
    return p.parse_args()


# ── File collection ───────────────────────────────────────────────────────────

def collect_files(src_dir: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for path in src_dir.rglob("*"):
        if path.is_file():
            rel = path.relative_to(src_dir).as_posix()
            try:
                files[rel] = path.read_bytes()
            except OSError:
                pass
    return files


# ── Statistics ────────────────────────────────────────────────────────────────

def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = (pct / 100) * (len(s) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (idx - lo) * (s[hi] - s[lo])


def compute_stats(samples: list[float]) -> dict[str, float]:
    if not samples:
        nan = float("nan")
        return {"avg": nan, "p50": nan, "p95": nan, "max": nan, "min": nan}
    return {
        "avg": statistics.mean(samples),
        "p50": percentile(samples, 50),
        "p95": percentile(samples, 95),
        "max": max(samples),
        "min": min(samples),
    }


# ── Printing ──────────────────────────────────────────────────────────────────

def _fmt(v: float) -> str:
    """Right-aligned cell (8 chars) with comma separators."""
    if math.isnan(v):
        return "     N/A"
    return f"{v:>8,.1f}"


def _md_row(cells: list[str], widths: list[int], aligns: list[str]) -> str:
    """Render a markdown row with per-column width and alignment ('l' or 'r')."""
    parts = []
    for cell, width, align in zip(cells, widths, aligns):
        if align == "r":
            parts.append(cell.rjust(width))
        else:
            parts.append(cell.ljust(width))
    return "| " + " | ".join(parts) + " |"


def _md_separator(widths: list[int], aligns: list[str]) -> str:
    """Render a markdown alignment separator like |:---|---:|."""
    parts = []
    for width, align in zip(widths, aligns):
        bar = "-" * max(width, 3)
        if align == "r":
            parts.append(bar[:-1] + ":")
        else:
            parts.append(bar)
    return "|" + "|".join(parts) + "|"


def print_lifecycle_table(rows: list[tuple[str, dict]]) -> None:
    headers = ["Operation", "avg", "p50", "p95", "max"]
    aligns  = ["l", "r", "r", "r", "r"]

    data_rows = [
        [label, _fmt(s["avg"]), _fmt(s["p50"]), _fmt(s["p95"]), _fmt(s["max"])]
        for label, s in rows
    ]
    widths = [
        max(len(headers[i]), max((len(r[i]) for r in data_rows), default=0))
        for i in range(len(headers))
    ]

    print()
    print("**Lifecycle (wall ms)**")
    print()
    print(_md_row(headers, widths, aligns))
    print(_md_separator(widths, aligns))
    for r in data_rows:
        print(_md_row(r, widths, aligns))


def print_exec_table(results: list[dict], has_server_ms: bool) -> None:
    if has_server_ms:
        headers = [
            "Case",
            "wall avg", "wall p50", "wall p95", "wall max",
            "srv avg",  "srv p50",  "srv p95",  "srv max",
        ]
        aligns = ["l", "r", "r", "r", "r", "r", "r", "r", "r"]
        data_rows = []
        for r in results:
            w, s = r["wall"], r["server"]
            data_rows.append([
                r["label"],
                _fmt(w["avg"]), _fmt(w["p50"]), _fmt(w["p95"]), _fmt(w["max"]),
                _fmt(s["avg"]), _fmt(s["p50"]), _fmt(s["p95"]), _fmt(s["max"]),
            ])
    else:
        headers = ["Case", "wall avg", "wall p50", "wall p95", "wall max"]
        aligns  = ["l", "r", "r", "r", "r"]
        data_rows = []
        for r in results:
            w = r["wall"]
            data_rows.append([
                r["label"],
                _fmt(w["avg"]), _fmt(w["p50"]), _fmt(w["p95"]), _fmt(w["max"]),
            ])

    widths = [
        max(len(headers[i]), max((len(r[i]) for r in data_rows), default=0))
        for i in range(len(headers))
    ]

    print()
    print("**Exec latency**")
    print()
    print(_md_row(headers, widths, aligns))
    print(_md_separator(widths, aligns))
    for r in data_rows:
        print(_md_row(r, widths, aligns))


# ── Provider abstraction ──────────────────────────────────────────────────────

class Provider:
    name: str = ""
    has_server_ms: bool = False

    def resolve_base(self, requested_base: str) -> str:
        """Override to substitute a writable base path on platforms where the
        requested path (e.g. /home/user/...) is not available.
        Default: return the path unchanged."""
        return requested_base

    def create_sandbox(self, label: str) -> Any:
        raise NotImplementedError

    def ingest_files(self, sandbox: Any, files: dict[str, bytes], base: str) -> None:
        raise NotImplementedError

    def exec_script(self, sandbox: Any, script: str, timeout_ms: int) -> tuple[float, float, str]:
        """Returns (wall_ms, server_ms_or_nan, stdout)."""
        raise NotImplementedError

    def delete_sandbox(self, sandbox: Any) -> None:
        raise NotImplementedError

    def cleanup_bench_sandboxes(self) -> None:
        raise NotImplementedError

    def sandbox_id(self, sandbox: Any) -> str:
        raise NotImplementedError


# ── VirtualFS provider ────────────────────────────────────────────────────────

class VirtualFSProvider(Provider):
    name = "VirtualFS"
    has_server_ms = True

    def __init__(self, api_url: str, auth_secret: str, sub: str) -> None:
        try:
            from virtualfs import Client
        except ImportError as exc:
            print(f"ERROR: Cannot import virtualfs SDK: {exc}", file=sys.stderr)
            print(f"Install it with: pip install {_REPO_ROOT / 'clients' / 'python'}", file=sys.stderr)
            sys.exit(1)
        self._client = Client(base_url=api_url, auth_secret=auth_secret, sub=sub).__enter__()
        self._Client = Client
        self._api_url = api_url
        self._auth_secret = auth_secret
        self._sub = sub

    def close(self) -> None:
        try:
            self._client.__exit__(None, None, None)
        except Exception:
            pass

    def create_sandbox(self, label: str) -> Any:
        return self._client.sandboxes.create(name=label)

    def ingest_files(self, sandbox: Any, files: dict[str, bytes], base: str) -> None:
        sandbox.ingest_files(files, base_path=base)

    def exec_script(self, sandbox: Any, script: str, timeout_ms: int) -> tuple[float, float, str]:
        t0 = time.perf_counter()
        result = sandbox.exec(script, timeout_ms=timeout_ms)
        wall_ms = (time.perf_counter() - t0) * 1000.0
        return wall_ms, float(result.duration_ms), result.stdout.strip()

    def delete_sandbox(self, sandbox: Any) -> None:
        sandbox.delete()

    def sandbox_id(self, sandbox: Any) -> str:
        return sandbox.id

    def cleanup_bench_sandboxes(self) -> None:
        try:
            sandboxes = self._client.sandboxes.list()
        except Exception as exc:
            print(f"  WARNING: could not list sandboxes for cleanup: {exc}", file=sys.stderr)
            return
        leftovers = [s for s in sandboxes if (s.name or "").startswith("bench-")]
        if not leftovers:
            return
        print(f"  Cleaning up {len(leftovers)} leftover sandbox(es)…")
        for s in leftovers:
            try:
                self._client.sandboxes.delete(s.id)
                print(f"    deleted {s.id} ({s.name})")
            except Exception as exc:
                print(f"    WARNING: failed to delete {s.id}: {exc}", file=sys.stderr)


# ── Daytona provider ──────────────────────────────────────────────────────────

class DaytonaProvider(Provider):
    name = "Daytona"
    has_server_ms = False

    def __init__(self, api_key: str, api_url: str) -> None:
        try:
            from daytona_sdk import Daytona, DaytonaConfig, FileUpload, CreateSandboxFromSnapshotParams
            self._FileUpload = FileUpload
            self._CreateParams = CreateSandboxFromSnapshotParams
        except ImportError as exc:
            print(f"ERROR: Cannot import daytona_sdk: {exc}", file=sys.stderr)
            print("Install it with: pip install daytona-sdk", file=sys.stderr)
            sys.exit(1)
        self._daytona = Daytona(DaytonaConfig(api_key=api_key, api_url=api_url))

    def close(self) -> None:
        pass

    def resolve_base(self, requested_base: str) -> str:
        """Spin up a probe sandbox, detect the writable home, substitute, tear down."""
        print(f"  Probing Daytona sandbox for writable home dir…", end="", flush=True)
        probe = self._daytona.create(self._CreateParams(name="bench-probe"))
        try:
            result = probe.process.exec("echo $HOME && pwd && whoami")
            lines = (result.result or "").strip().splitlines()
            home = lines[0].strip() if lines else ""
            if not home or not home.startswith("/"):
                home = "/tmp"
            # Substitute /home/user prefix with detected home
            if requested_base.startswith("/home/user"):
                resolved = requested_base.replace("/home/user", home, 1)
            else:
                resolved = requested_base
            print(f" home={home}  base={resolved}")
            return resolved
        finally:
            try:
                self._daytona.delete(probe)
            except Exception:
                pass

    def create_sandbox(self, label: str) -> Any:
        params = self._CreateParams(name=label)
        return self._daytona.create(params)

    def ingest_files(self, sandbox: Any, files: dict[str, bytes], base: str) -> None:
        # Ensure the base directory exists
        sandbox.process.exec(f"mkdir -p {base}")
        uploads = [
            self._FileUpload(source=content, destination=f"{base}/{rel}")
            for rel, content in files.items()
        ]
        sandbox.fs.upload_files(uploads)

    def exec_script(self, sandbox: Any, script: str, timeout_ms: int) -> tuple[float, float, str]:
        t0 = time.perf_counter()
        result = sandbox.process.exec(script, timeout=timeout_ms // 1000)
        wall_ms = (time.perf_counter() - t0) * 1000.0
        stdout = (result.result or "").strip()
        return wall_ms, float("nan"), stdout

    def delete_sandbox(self, sandbox: Any) -> None:
        self._daytona.delete(sandbox)

    def sandbox_id(self, sandbox: Any) -> str:
        return sandbox.id

    def cleanup_bench_sandboxes(self) -> None:
        try:
            paginated = self._daytona.list()
            sandboxes = paginated.items or []
        except Exception as exc:
            print(f"  WARNING: could not list sandboxes for cleanup: {exc}", file=sys.stderr)
            return
        leftovers = [s for s in sandboxes if (s.name or "").startswith("bench-")]
        if not leftovers:
            return
        print(f"  Cleaning up {len(leftovers)} leftover sandbox(es)…")
        for s in leftovers:
            try:
                self._daytona.delete(s)
                print(f"    deleted {s.id} ({s.name})")
            except Exception as exc:
                print(f"    WARNING: failed to delete {s.id}: {exc}", file=sys.stderr)


# ── Lifecycle benchmark ───────────────────────────────────────────────────────

def run_lifecycle_benchmark(
    provider: Provider,
    files: dict[str, bytes],
    base: str,
    n: int,
) -> tuple[dict, dict, dict]:
    create_samples: list[float] = []
    ingest_samples: list[float] = []
    delete_samples: list[float] = []

    for i in range(n):
        print(f"  lifecycle run {i + 1}/{n}…", end="", flush=True)

        t0 = time.perf_counter()
        sandbox = provider.create_sandbox(f"bench-lifecycle-{i}")
        create_ms = (time.perf_counter() - t0) * 1000.0
        create_samples.append(create_ms)

        try:
            t1 = time.perf_counter()
            provider.ingest_files(sandbox, files, base)
            ingest_ms = (time.perf_counter() - t1) * 1000.0
            ingest_samples.append(ingest_ms)

            t2 = time.perf_counter()
            provider.delete_sandbox(sandbox)
            delete_ms = (time.perf_counter() - t2) * 1000.0
            delete_samples.append(delete_ms)

            print(f" create {create_ms:.0f} ms  ingest {ingest_ms:.0f} ms  delete {delete_ms:.0f} ms")
        except Exception as exc:
            print(f" ERROR: {exc} — attempting cleanup", file=sys.stderr)
            try:
                provider.delete_sandbox(sandbox)
            except Exception:
                pass

    return (
        compute_stats(create_samples),
        compute_stats(ingest_samples),
        compute_stats(delete_samples),
    )


# ── Exec benchmark ────────────────────────────────────────────────────────────

def run_exec_case(
    provider: Provider,
    sandbox: Any,
    script: str,
    runs: int,
    timeout_ms: int,
) -> tuple[list[float], list[float], str]:
    wall_samples: list[float] = []
    srv_samples: list[float] = []
    last_stdout = ""
    for _ in range(runs):
        wall_ms, server_ms, stdout = provider.exec_script(sandbox, script, timeout_ms)
        wall_samples.append(wall_ms)
        srv_samples.append(server_ms)
        last_stdout = stdout
    return wall_samples, srv_samples, last_stdout


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()

    src_dir = Path(args.src_dir).resolve()
    if not src_dir.is_dir():
        print(f"ERROR: --src-dir '{src_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    requested_base = args.base_path.rstrip("/")

    # Build provider
    if args.provider == "virtualfs":
        if not args.auth_secret:
            print("ERROR: --auth-secret or AUTH_SECRET is required for virtualfs provider", file=sys.stderr)
            sys.exit(1)
        provider: Provider = VirtualFSProvider(args.api_url, args.auth_secret, args.sub)
    else:
        if not args.daytona_api_key:
            print("ERROR: --daytona-api-key or DAYTONA_API_KEY is required for daytona provider", file=sys.stderr)
            sys.exit(1)
        provider = DaytonaProvider(args.daytona_api_key, args.daytona_api_url)

    # Resolve base path (provider may substitute for writable home dir)
    base = provider.resolve_base(requested_base)

    exec_cases: list[tuple[str, str]] = [
        # ── baseline ────────────────────────────────────────────────────────
        ("echo (baseline)",              "echo benchmark-baseline"),

        # ── find ────────────────────────────────────────────────────────────
        ("find: all files",              f"find {base} -type f | wc -l"),
        ("find: *.ts",                   f"find {base} -name '*.ts' | wc -l"),
        ("find: dirs only",              f"find {base} -type d | wc -l"),
        ("find: maxdepth 2",             f"find {base} -maxdepth 2 -type f | wc -l"),
        ("find: *.ts | sort | head",     f"find {base} -name '*.ts' | sort | head -20"),
        ("find: *.ts | xargs wc -l",     f"find {base} -name '*.ts' | xargs wc -l | tail -1"),
        ("find: *.ts | xargs grep",      f"find {base} -name '*.ts' | xargs grep -l 'interface' | wc -l"),

        # ── grep ────────────────────────────────────────────────────────────
        ("grep: lines (interface)",      f"grep -r 'interface' {base} --include='*.ts' | wc -l"),
        ("grep: files (SqlFs)",          f"grep -rl 'SqlFs' {base}"),
        ("grep: case-insensitive",       f"grep -ri 'async' {base} --include='*.ts' | wc -l"),
        ("grep: word boundary",          f"grep -rw 'type' {base} --include='*.ts' | wc -l"),
        ("grep: fixed string",           f"grep -rF 'Promise<' {base} --include='*.ts' | wc -l"),
        ("grep: with line numbers",      f"grep -rn 'export' {base} --include='*.ts' | wc -l"),
        ("grep: two patterns",           f"grep -rE 'interface|type' {base} --include='*.ts' | wc -l"),

        # ── rg ──────────────────────────────────────────────────────────────
        ("rg: lines (interface)",        f"rg 'interface' {base} -t ts | wc -l"),
        ("rg: files (SqlFs)",            f"rg -l 'SqlFs' {base}"),
        ("rg: case-insensitive",         f"rg -i 'async' {base} -t ts | wc -l"),
        ("rg: word boundary",            f"rg -w 'type' {base} -t ts | wc -l"),
        ("rg: fixed string",             f"rg -F 'Promise<' {base} -t ts | wc -l"),
        ("rg: with line numbers",        f"rg -n 'export' {base} -t ts | wc -l"),
        ("rg: two patterns",             f"rg 'interface|type' {base} -t ts | wc -l"),
        ("rg: count per file",           f"rg -c 'interface' {base} -t ts | wc -l"),
        ("rg: stats",                    f"rg --stats 'interface' {base} -t ts 2>&1 | tail -5"),

        # ── write ────────────────────────────────────────────────────────────
        ("write: echo small",            "echo 'benchmark content' > /tmp/bw.txt"),
        ("write: 100 lines",             "for i in $(seq 1 100); do echo \"line $i\"; done > /tmp/bw100.txt"),
        ("write: 1k lines",              "for i in $(seq 1 1000); do echo \"line $i\"; done > /tmp/bw1k.txt"),
        ("write: copy ts file",          f"cp {base}/fs/sql-fs/sql-fs.ts /tmp/bw-copy.ts"),
        ("write: append 3x",             "rm -f /tmp/bw-app.txt && echo 'a' >> /tmp/bw-app.txt && echo 'b' >> /tmp/bw-app.txt && echo 'c' >> /tmp/bw-app.txt"),

        # ── delete ───────────────────────────────────────────────────────────
        ("delete: single file",          "echo x > /tmp/bd.txt && rm /tmp/bd.txt"),
        ("delete: 3 files",              "echo x > /tmp/bd-1.txt && echo x > /tmp/bd-2.txt && echo x > /tmp/bd-3.txt && rm /tmp/bd-1.txt /tmp/bd-2.txt /tmp/bd-3.txt"),
        ("delete: dir + file",           "mkdir -p /tmp/bd-dir && echo x > /tmp/bd-dir/f.txt && rm -rf /tmp/bd-dir"),

        # ── mkdir ────────────────────────────────────────────────────────────
        ("mkdir: single",                "mkdir -p /tmp/bm-dir && rmdir /tmp/bm-dir"),
        ("mkdir: nested deep",           "mkdir -p /tmp/bm/a/b/c/d/e && rm -rf /tmp/bm"),

        # ── mv ───────────────────────────────────────────────────────────────
        ("mv: rename file",              "echo x > /tmp/mv-src.txt && mv /tmp/mv-src.txt /tmp/mv-dst.txt && rm /tmp/mv-dst.txt"),
        ("mv: move to subdir",           "echo x > /tmp/mv-f.txt && mkdir -p /tmp/mv-dir && mv /tmp/mv-f.txt /tmp/mv-dir/ && rm -rf /tmp/mv-dir"),
        ("mv: rename dir",               "mkdir -p /tmp/mv-dira && mv /tmp/mv-dira /tmp/mv-dirb && rmdir /tmp/mv-dirb"),
        ("mv: move 3 files",             "echo x > /tmp/mv-1.txt && echo x > /tmp/mv-2.txt && echo x > /tmp/mv-3.txt && mkdir -p /tmp/mv-dest && mv /tmp/mv-1.txt /tmp/mv-2.txt /tmp/mv-3.txt /tmp/mv-dest/ && rm -rf /tmp/mv-dest"),
    ]

    print(f"Scanning {src_dir}…", end="", flush=True)
    files = collect_files(src_dir)
    print(f" {len(files)} files")

    print()
    print("Remote Bash Latency Benchmark")
    print("==============================")
    print(f"Provider: {provider.name}")
    if args.provider == "virtualfs":
        print(f"API:      {args.api_url}")
    else:
        print(f"API:      {args.daytona_api_url}")
    print(f"Source:   {args.src_dir}  →  {base}  ({len(files)} files)")
    print(f"Lifecycle runs: {args.lifecycle_runs}  |  Exec warmup: {args.warmup}  |  Exec runs: {args.runs}")

    try:
        # ── Phase 1: Lifecycle ──
        print()
        print("Phase 1: Sandbox lifecycle (create / ingest / delete)")
        print("─" * 55)
        create_stats, ingest_stats, delete_stats = run_lifecycle_benchmark(
            provider, files, base, args.lifecycle_runs
        )
        print_lifecycle_table([
            ("sandbox create", create_stats),
            (f"ingest {len(files)} files", ingest_stats),
            ("sandbox delete", delete_stats),
        ])

        # ── Phase 2: Exec benchmark ──
        print()
        print("Phase 2: Exec latency (grep / rg / find)")
        print("─" * 45)
        print(f"  Creating exec sandbox…", end="", flush=True)
        exec_sandbox = provider.create_sandbox("bench-exec")
        print(f" {provider.sandbox_id(exec_sandbox)}")

        try:
            print(f"  Ingesting {len(files)} files…", end="", flush=True)
            t0 = time.perf_counter()
            provider.ingest_files(exec_sandbox, files, base)
            print(f" {(time.perf_counter() - t0) * 1000:.0f} ms")
            print()

            exec_results = []
            for label, script in exec_cases:
                print(f"  {label}…", end="", flush=True)
                for _ in range(args.warmup):
                    provider.exec_script(exec_sandbox, script, args.timeout_ms)
                wall_samples, srv_samples, preview = run_exec_case(
                    provider, exec_sandbox, script, args.runs, args.timeout_ms
                )
                avg_wall = statistics.mean(wall_samples)
                print(f" {avg_wall:.1f} ms avg")
                exec_results.append({
                    "label": label,
                    "wall": compute_stats(wall_samples),
                    "server": compute_stats(srv_samples),
                    "preview": preview[:80],
                })

            print_exec_table(exec_results, provider.has_server_ms)

            print()
            print("stdout previews (first 80 chars):")
            for r in exec_results:
                print(f"  {r['label']:<35}  {repr(r['preview'])}")

        finally:
            print()
            print(f"  Deleting exec sandbox…", end="", flush=True)
            t0 = time.perf_counter()
            try:
                provider.delete_sandbox(exec_sandbox)
                print(f" {(time.perf_counter() - t0) * 1000:.0f} ms")
            except Exception as exc:
                print(f" WARNING: delete failed ({exc})", file=sys.stderr)

    finally:
        print()
        print("Final cleanup (sweeping any leftover bench-* sandboxes)…")
        provider.cleanup_bench_sandboxes()
        if hasattr(provider, "close"):
            provider.close()


if __name__ == "__main__":
    main()
