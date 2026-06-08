"""End-to-end demo of the SQL-FS Python SDK.

Run with:

    BASE_URL=https://... AUTH_SECRET=... python examples/quickstart.py
"""

from __future__ import annotations

import os
import sys

from sqlfs import Client


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
            # Bulk write — single round-trip for many files.
            sb.fs.write_files(
                {
                    "/home/user/hello.txt": "hello, world\n",
                    "/home/user/main.sh": "#!/bin/bash\necho from main.sh\n",
                }
            )

            # Exec — flat result object.
            r = sb.exec("cat /home/user/hello.txt && bash /home/user/main.sh")
            print(f"exit={r.exit_code} ok={r.ok} duration={r.duration_ms}ms")
            print(f"stdout:\n{r.stdout}")
            if r.error:
                print(f"stderr:\n{r.error}")

            # Batch exec — multiple commands, one round-trip.
            results = sb.exec_batch(
                [
                    {"id": "ls", "script": "ls /home/user"},
                    {"id": "uname", "script": "uname -a"},
                ]
            )
            for br in results:
                print(f"[{br.id}] exit={br.exit_code} stdout={br.stdout!r}")

            # Streaming exec.
            print("--- stream ---")
            for ev in sb.exec_stream("for i in 1 2 3; do echo $i; done"):
                if ev.type == "stdout":
                    print(ev.data, end="")
                elif ev.type == "exit":
                    print(f"[stream exit={ev.exit_code}]")

            # Tree listing.
            for entry in sb.fs.tree(prefix="/home/user", depth=2):
                print(f"{entry.kind:7} {entry.size:>8}  {entry.path}")
        finally:
            sb.delete()
            print(f"deleted sandbox {sb.id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
