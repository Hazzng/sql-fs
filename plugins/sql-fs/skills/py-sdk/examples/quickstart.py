"""Quickstart — create a sandbox, exec a script, clean up.

Run with:
    BASE_URL=...  AUTH_SECRET=...  python quickstart.py
"""

from __future__ import annotations

import os
import sys

from sqlfs import Client, ExecTimeoutError


def main() -> int:
    base_url = os.environ.get("BASE_URL")
    auth_secret = os.environ.get("AUTH_SECRET")
    token = os.environ.get("TOKEN")
    if not base_url or not (auth_secret or token):
        print("set BASE_URL and either AUTH_SECRET or TOKEN", file=sys.stderr)
        return 2

    with Client(
        base_url=base_url,
        auth_secret=auth_secret,
        token=token,
        sub="quickstart",
    ) as fs:
        sb = fs.sandboxes.create(name="quickstart")
        print(f"created sandbox {sb.id}")
        try:
            # Single buffered exec — get back a flat ExecResult.
            r = sb.exec("echo hello && uname -srm")
            if not r.ok:
                print(f"unexpected exit {r.exit_code}: {r.error}", file=sys.stderr)
                return 1
            print(f"--- stdout (exit={r.exit_code}, {r.duration_ms} ms) ---")
            print(r.stdout)

            # Demonstrate timeout handling — exec scripts that exceed timeout_ms
            # surface as ExecTimeoutError, not as a failed-result row.
            try:
                sb.exec("sleep 5", timeout_ms=1_000)
            except ExecTimeoutError as e:
                print(f"(expected) timed out after {e.duration_ms} ms")
        finally:
            fs.sandboxes.delete(sb.id)
            print(f"deleted sandbox {sb.id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
