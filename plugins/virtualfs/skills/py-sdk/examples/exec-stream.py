"""Streaming exec — consume stdout/stderr as it's produced.

Use `sb.exec_stream(...)` when:
  - the script produces output incrementally and you want it live (build logs)
  - you want to short-circuit on a specific output pattern

Otherwise prefer `sb.exec(...)` (buffered) — simpler, no SSE framing overhead.

Run with:
    BASE_URL=... AUTH_SECRET=... python exec-stream.py
"""

from __future__ import annotations

import os
import sys

from virtualfs import Client


def main() -> int:
    with Client(
        base_url=os.environ["BASE_URL"],
        auth_secret=os.environ["AUTH_SECRET"],
        sub="streamer",
    ) as fs:
        sb = fs.sandboxes.create(name="stream-demo")
        try:
            script = """
            for i in 1 2 3 4 5; do
              echo "stdout line $i"
              if [ $i -eq 3 ]; then
                echo "warning at 3" >&2
              fi
              sleep 0.2
            done
            """

            stdout_chunks: list[str] = []
            exit_event = None

            # The iterator closes the underlying connection automatically on
            # exit OR when you `break` out — so it's safe to short-circuit.
            for ev in sb.exec_stream(script, timeout_ms=15_000):
                if ev.type == "stdout":
                    sys.stdout.write(ev.data or "")
                    sys.stdout.flush()
                    stdout_chunks.append(ev.data or "")
                elif ev.type == "stderr":
                    sys.stderr.write(f"[stderr] {ev.data}")
                    sys.stderr.flush()
                elif ev.type == "exit":
                    exit_event = ev

            if exit_event:
                print(
                    f"\n--- exit code={exit_event.exit_code} "
                    f"duration={exit_event.duration_ms} ms ---"
                )

            # Pattern: short-circuit the stream the moment a sentinel appears.
            # Demonstrated as a separate run so the previous output is visible.
            print("\n[short-circuit demo] stop streaming after 'STOP' line:")
            for ev in sb.exec_stream(
                "for i in 1 2 3 4 5; do echo line-$i; done; echo STOP; sleep 5; echo never",
                timeout_ms=10_000,
            ):
                if ev.type == "stdout":
                    sys.stdout.write(ev.data or "")
                    sys.stdout.flush()
                    if "STOP" in (ev.data or ""):
                        break  # connection closed by the iterator's finally:
        finally:
            fs.sandboxes.delete(sb.id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
