"""Bulk-ingest a local folder, then explore the codebase via exec_batch.

Demonstrates the canonical agent workflow:
  1. ONE round-trip via `sb.ingest_files(...)` to bootstrap the sandbox.
  2. ALL subsequent reads/lists via `sb.exec_batch([...])` (one round-trip).
  3. Clean up.

Compare wall-clock cost: per-file `fs.write` would cost N HTTP round-trips
(seconds-per-file at typical RTT). `ingest_files` is one round-trip regardless
of file count.

Run with:
    BASE_URL=... AUTH_SECRET=... python ingest-explore.py /path/to/local/code
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from virtualfs import Client

SANDBOX_BASE = "/home/user/proj"
SKIP_DIRS = {"__pycache__", ".git", ".mypy_cache", ".pytest_cache", "node_modules"}
SKIP_SUFFIXES = {".pyc", ".pyo"}


def collect(root: Path) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for p in root.rglob("*"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.suffix in SKIP_SUFFIXES or p.name == ".DS_Store":
            continue
        if p.is_file():
            out[p.relative_to(root).as_posix()] = p.read_bytes()
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <local-folder>", file=sys.stderr)
        return 2
    folder = Path(sys.argv[1]).expanduser().resolve()
    if not folder.is_dir():
        print(f"not a directory: {folder}", file=sys.stderr)
        return 2

    print(f"walking {folder} ...")
    files = collect(folder)
    total = sum(len(v) for v in files.values())
    print(f"  {len(files)} files, {total:,} bytes")

    with Client(
        base_url=os.environ["BASE_URL"],
        auth_secret=os.environ["AUTH_SECRET"],
        sub="ingest-explore",
    ) as fs:
        sb = fs.sandboxes.create(name="ingest-explore")
        try:
            t = time.perf_counter()
            sb.ingest_files(files, base_path=SANDBOX_BASE)
            print(f"ingest_files: {(time.perf_counter() - t) * 1000:.0f} ms "
                  f"({len(files)} files, 1 HTTP round-trip)")

            # Build an exploration probe-set. Every probe runs in ONE batch
            # round-trip. Add or trim freely — the batch endpoint handles up to
            # 50 scripts and shares a single timeout budget.
            probes = [
                ("tree",
                 f"find {SANDBOX_BASE} -type f -printf '%s %p\\n' | sort -rn | head -10"),
                ("py_count",
                 f"find {SANDBOX_BASE} -name '*.py' | wc -l"),
                ("imports",
                 f"grep -rhn '^import \\|^from ' {SANDBOX_BASE} 2>/dev/null "
                 f"| sort -u | head -20"),
                ("classes",
                 f"grep -rhn '^class ' {SANDBOX_BASE} 2>/dev/null | head -15"),
                ("todos",
                 f"grep -rn 'TODO\\|FIXME' {SANDBOX_BASE} 2>/dev/null | head -10"),
                ("entry_point",
                 f"find {SANDBOX_BASE} -maxdepth 2 -name '__init__.py' -o "
                 f"-name 'main.py' -o -name 'app.py' | head -5"),
            ]

            t = time.perf_counter()
            results = sb.exec_batch(
                [{"id": label, "script": script} for label, script in probes],
                timeout_ms=60_000,
            )
            print(f"exec_batch:    {(time.perf_counter() - t) * 1000:.0f} ms "
                  f"for {len(probes)} probes (1 round-trip)")

            for r in results:
                head = r.stdout.rstrip().splitlines()[:8]
                print(f"\n[{r.id}] exit={r.exit_code}")
                for line in head:
                    print(f"  {line}")
        finally:
            fs.sandboxes.delete(sb.id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
