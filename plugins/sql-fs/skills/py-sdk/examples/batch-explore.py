"""Agent exploration via exec_batch — one round-trip, many probes.

This is the canonical pattern for an LLM agent doing initial code reconnaissance
on a freshly-ingested sandbox. Each probe is independent, so they run as one
batch — wall-clock cost is the cost of a single round-trip.

Compare:
  - 8 individual `sb.exec(...)` calls: ~8 × 700 ms = ~5.6 s
  - 1 `sb.exec_batch([...])` with 8 scripts: ~700 ms

Run with:
    BASE_URL=... AUTH_SECRET=... python batch-explore.py
    # (assumes the sandbox is already populated by ingest-explore.py)
"""

from __future__ import annotations

import os
import sys

from sqlfs import Client

SANDBOX_BASE = "/home/user/proj"


def explore(sb) -> dict[str, str]:
    """Return a mapping of probe-id → stdout for each exploration probe."""
    probes = {
        "tree":         f"find {SANDBOX_BASE} -type f | head -50",
        "py_count":     f"find {SANDBOX_BASE} -name '*.py' | wc -l",
        "biggest":      f"find {SANDBOX_BASE} -type f -printf '%s %p\\n' "
                        f"| sort -rn | head -5",
        "imports":      f"grep -rhn '^import \\|^from ' {SANDBOX_BASE} 2>/dev/null "
                        f"| sort -u | head -30",
        "classes":      f"grep -rn '^class ' {SANDBOX_BASE} 2>/dev/null | head -15",
        "functions":    f"grep -c '^def ' $(find {SANDBOX_BASE} -name '*.py') "
                        f"2>/dev/null | head -10",
        "todos":        f"grep -rn 'TODO\\|FIXME\\|XXX' {SANDBOX_BASE} 2>/dev/null "
                        f"| head -10",
        "entrypoints":  f"find {SANDBOX_BASE} -maxdepth 3 "
                        f"-name 'main.py' -o -name 'app.py' -o -name '__main__.py'",
    }
    results = sb.exec_batch(
        [{"id": pid, "script": script} for pid, script in probes.items()],
        timeout_ms=60_000,
    )
    return {r.id: r.stdout for r in results if r.ok}


def main() -> int:
    sandbox_id = os.environ.get("SANDBOX_ID")
    with Client(
        base_url=os.environ["BASE_URL"],
        auth_secret=os.environ["AUTH_SECRET"],
        sub="batch-explorer",
    ) as fs:
        if sandbox_id:
            sb = fs.sandboxes.attach(sandbox_id)
            print(f"attached to {sb.id}")
        else:
            sb = fs.sandboxes.create(name="batch-explore")
            print(f"created empty sandbox {sb.id}; ingest something into "
                  f"{SANDBOX_BASE} first or set SANDBOX_ID env var")
            fs.sandboxes.delete(sb.id)
            return 1

        try:
            findings = explore(sb)
            for pid, stdout in findings.items():
                preview = stdout.rstrip().splitlines()[:6]
                print(f"\n[{pid}]")
                for line in preview:
                    print(f"  {line}")
        finally:
            # Don't delete an attached sandbox — caller owns its lifecycle.
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
