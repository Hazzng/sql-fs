"""
Live integration test suite for SQL-FS.
Tests: sandbox CRUD, file ops, exec semantics, concurrency/locking,
caching behaviour, streaming, error handling, exec_batch performance.

Usage:
    export BASE_URL=https://sql-fs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io
    export AUTH_SECRET=b882d28f4ddeb27d778c1f11e75ad96703ff3830b327dabd5c158e9942237d04
    python test_sql-fs_live.py
"""

import os
import sys
import time
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from sqlfs import (
    Client,
    Sandbox,
    SQLFSError,
    AuthError,
    NotFoundError,
    ConflictError,
    ValidationError,
    ExecTimeoutError,
    ServerError,
)

BASE_URL = os.environ.get("BASE_URL", "https://sql-fs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io")
AUTH_SECRET = os.environ.get("AUTH_SECRET", "b882d28f4ddeb27d778c1f11e75ad96703ff3830b327dabd5c158e9942237d04")

# ── helpers ─────────────────────────────────────────────────────────────────

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
INFO = "\033[34m·\033[0m"

_results: list[tuple[str, bool, str]] = []
_lock = threading.Lock()


def record(name: str, passed: bool, note: str = "") -> None:
    with _lock:
        _results.append((name, passed, note))
    icon = PASS if passed else FAIL
    print(f"  {icon} {name}" + (f"  [{note}]" if note else ""))


def expect(name: str, condition: bool, note: str = "") -> None:
    record(name, condition, note)
    if not condition:
        raise AssertionError(f"FAILED: {name} — {note}")


def make_client() -> Client:
    return Client(base_url=BASE_URL, auth_secret=AUTH_SECRET, sub="test-runner", expires_in="1y")


# ── test groups ──────────────────────────────────────────────────────────────

def test_sandbox_lifecycle(fs: Client) -> None:
    print("\n── 1. Sandbox lifecycle ──")
    sb = fs.sandboxes.create(name="lifecycle-test")
    try:
        expect("create returns Sandbox", isinstance(sb, Sandbox))
        expect("sandbox id is a string", isinstance(sb.id, str) and len(sb.id) > 0)

        info = fs.sandboxes.get(sb.id)
        expect("get returns correct id", info.id == sb.id)

        listing = fs.sandboxes.list()
        ids = [s.id for s in listing]
        expect("list includes new sandbox", sb.id in ids)

        attached = fs.sandboxes.attach(sb.id)
        r = attached.exec("echo attached-ok")
        expect("attach + exec works", r.ok and "attached-ok" in r.stdout)
    finally:
        sb.delete()

    try:
        fs.sandboxes.get(sb.id)
        record("deleted sandbox raises NotFoundError", False, "no exception raised")
    except NotFoundError:
        record("deleted sandbox raises NotFoundError", True)


def test_exec_basics(fs: Client) -> None:
    print("\n── 2. Exec basics ──")
    sb = fs.sandboxes.create(name="exec-basics")
    try:
        r = sb.exec("echo hello-world")
        expect("stdout captured", "hello-world" in r.stdout)
        expect("exit_code 0", r.exit_code == 0)
        expect("ok True", r.ok)
        expect("duration_ms present", isinstance(r.duration_ms, int) and r.duration_ms >= 0)

        r2 = sb.exec("exit 42")
        expect("non-zero exit_code", r2.exit_code == 42)
        expect("ok False for non-zero", not r2.ok)

        r3 = sb.exec("echo err >&2")
        expect("stderr captured", "err" in r3.stderr)

        r4 = sb.exec("echo $FOO", env={"FOO": "bar-baz"})
        expect("per-exec env passed", "bar-baz" in r4.stdout)

        r5 = sb.exec("pwd", cwd="/tmp")
        expect("cwd respected", "/tmp" in r5.stdout.strip())

        # Each exec call is a separate script invocation; filesystem state persists but shell vars don't.
        sb.exec("echo 42 > /home/user/state.txt")
        r7 = sb.exec("cat /home/user/state.txt")
        expect("filesystem state persists across exec calls", "42" in r7.stdout)
    finally:
        sb.delete()


def test_file_operations(fs: Client) -> None:
    print("\n── 3. File operations via exec ──")
    sb = fs.sandboxes.create(name="file-ops")
    try:
        sb.exec("mkdir -p /home/user/proj")
        sb.exec("echo 'Hello SQL-FS' > /home/user/proj/readme.txt")

        r = sb.exec("cat /home/user/proj/readme.txt")
        expect("write + read file", "Hello SQL-FS" in r.stdout)

        sb.exec("mkdir -p /home/user/proj/sub")
        r2 = sb.exec("find /home/user/proj -type f")
        expect("mkdir + find works", "readme.txt" in r2.stdout)

        sb.exec("cp /home/user/proj/readme.txt /home/user/proj/copy.txt")
        r3 = sb.exec("cat /home/user/proj/copy.txt")
        expect("file copy works", "Hello SQL-FS" in r3.stdout)

        sb.exec("rm /home/user/proj/copy.txt")
        r4 = sb.exec("ls /home/user/proj/copy.txt 2>&1; echo $?")
        expect("file delete works", r4.stdout.strip().endswith("1") or "No such" in r4.stdout)

        r5 = sb.exec("cat /home/user/proj/readme.txt", read_only=True)
        expect("read_only exec succeeds for reads", r5.ok and "Hello SQL-FS" in r5.stdout)

        try:
            sb.exec("echo x > /home/user/proj/nope.txt", read_only=True)
            record("read_only blocks writes", False, "write succeeded — should have failed")
        except ValidationError as e:
            record("read_only blocks writes", True, f"code={e.code}")
    finally:
        sb.delete()


def test_ingest_files(fs: Client) -> None:
    print("\n── 4. ingest_files bootstrap ──")
    sb = fs.sandboxes.create(name="ingest-test")
    try:
        resp = sb.ingest_files(
            {
                "main.py": "print('ingest works')\n",
                "lib/util.py": "def helper(): return 42\n",
                "data/binary.bin": b"\x00\x01\x02\x03\xff",
            },
            base_path="/home/user/project",
        )
        expect("ingest returns status ok", resp.get("status") == "ok")
        expect("ingest reports file count", resp.get("fileCount", 0) >= 3)

        r = sb.exec("cat /home/user/project/main.py")
        expect("text file ingested correctly", "ingest works" in r.stdout)

        r2 = sb.exec("cat /home/user/project/lib/util.py")
        expect("nested file ingested", "def helper" in r2.stdout)

        r3 = sb.exec("wc -c < /home/user/project/data/binary.bin")
        expect("binary file size correct", r3.stdout.strip() == "5")
    finally:
        sb.delete()


def test_exec_batch(fs: Client) -> None:
    print("\n── 5. exec_batch ──")
    sb = fs.sandboxes.create(name="batch-test")
    try:
        sb.exec("mkdir -p /home/user/data && echo alpha > /home/user/data/a.txt && echo beta > /home/user/data/b.txt")

        t0 = time.monotonic()
        results = sb.exec_batch(
            [
                {"id": "ls", "script": "ls /home/user/data"},
                {"id": "cat_a", "script": "cat /home/user/data/a.txt"},
                {"id": "cat_b", "script": "cat /home/user/data/b.txt"},
                {"id": "uname", "script": "uname -s"},
                {"id": "echo1", "script": "echo batch1"},
                {"id": "echo2", "script": "echo batch2"},
            ],
            timeout_ms=30_000,
            per_script_timeout_ms=5_000,
        )
        elapsed = time.monotonic() - t0

        expect("batch returns 6 results", len(results) == 6)
        by_id = {r.id: r for r in results}
        expect("ls result ok", by_id["ls"].ok and "a.txt" in by_id["ls"].stdout)
        expect("cat_a content", "alpha" in by_id["cat_a"].stdout)
        expect("cat_b content", "beta" in by_id["cat_b"].stdout)
        expect("all results have id", all(r.id for r in results))
        print(f"    {INFO} batch of 6 took {elapsed*1000:.0f} ms")

        # read_only batch should run in parallel
        t0 = time.monotonic()
        ro_results = sb.exec_batch(
            [{"id": f"probe_{i}", "script": f"echo {i}"} for i in range(10)],
            timeout_ms=30_000,
            read_only=True,
        )
        elapsed_ro = time.monotonic() - t0
        expect("read_only batch returns 10 results", len(ro_results) == 10)
        expect("all read_only results ok", all(r.ok for r in ro_results))
        print(f"    {INFO} read_only batch of 10 took {elapsed_ro*1000:.0f} ms")
    finally:
        sb.delete()


def test_exec_streaming(fs: Client) -> None:
    print("\n── 6. exec_stream (SSE) ──")
    sb = fs.sandboxes.create(name="stream-test")
    try:
        chunks: list[str] = []
        exit_codes: list[int] = []
        for ev in sb.exec_stream("for i in 1 2 3 4 5; do echo line_$i; done"):
            if ev.type == "stdout":
                chunks.append(ev.data)
            elif ev.type == "exit":
                exit_codes.append(ev.exit_code)

        combined = "".join(chunks)
        expect("stream delivers all lines", all(f"line_{i}" in combined for i in range(1, 6)))
        expect("stream exit event received", len(exit_codes) == 1)
        expect("stream exit_code 0", exit_codes[0] == 0)

        stderr_chunks: list[str] = []
        for ev in sb.exec_stream("echo oops >&2; exit 7"):
            if ev.type == "stderr":
                stderr_chunks.append(ev.data)
        expect("stream captures stderr", "oops" in "".join(stderr_chunks))
    finally:
        sb.delete()


def test_error_handling(fs: Client) -> None:
    print("\n── 7. Error handling ──")

    # Bad auth
    with Client(base_url=BASE_URL, auth_secret="bad-secret-000", sub="bad") as bad_fs:
        try:
            bad_fs.sandboxes.list()
            record("bad auth raises AuthError", False, "no exception")
        except AuthError as e:
            record("bad auth raises AuthError", True, f"status={e.status}")
        except SQLFSError as e:
            record("bad auth raises AuthError", False, f"got {type(e).__name__} instead")

    # NotFoundError
    with make_client() as fs:
        try:
            fs.sandboxes.get("00000000-0000-0000-0000-000000000000")
            record("missing sandbox raises NotFoundError", False, "no exception")
        except NotFoundError:
            record("missing sandbox raises NotFoundError", True)

    # ExecTimeoutError
    with make_client() as fs:
        sb = fs.sandboxes.create(name="timeout-test")
        try:
            sb.exec("sleep 60", timeout_ms=2_000)
            record("exec timeout raises ExecTimeoutError", False, "no exception")
        except ExecTimeoutError as e:
            record("exec timeout raises ExecTimeoutError", True, f"duration_ms={e.duration_ms}")
        finally:
            sb.delete()


def test_exec_atomicity(fs: Client) -> None:
    """Counter stress test: N threads do read-modify-write in one exec call."""
    print("\n── 8. Exec atomicity (read-modify-write in single exec) ──")
    NUM_WORKERS = 8
    INCREMENTS = 5
    sb = fs.sandboxes.create(name="atomicity-test")
    try:
        sb.exec("echo 0 > /home/user/counter.txt")

        errors: list[str] = []

        def increment(_: Any) -> None:
            for _ in range(INCREMENTS):
                r = sb.exec(
                    "val=$(cat /home/user/counter.txt); echo $((val + 1)) > /home/user/counter.txt; echo $((val + 1))"
                )
                if not r.ok:
                    errors.append(r.stderr)

        with ThreadPoolExecutor(max_workers=NUM_WORKERS) as pool:
            list(pool.map(increment, range(NUM_WORKERS)))

        r_final = sb.exec("cat /home/user/counter.txt")
        final = int(r_final.stdout.strip())
        expected = NUM_WORKERS * INCREMENTS
        expect(
            f"atomic counter = {expected} (no races)",
            final == expected,
            f"got {final}, expected {expected}",
        )
        expect("no exec errors during atomicity test", len(errors) == 0, str(errors[:3]))
    finally:
        sb.delete()


def test_concurrent_sandboxes(fs: Client) -> None:
    """Create multiple sandboxes simultaneously and exec concurrently."""
    print("\n── 9. Concurrent sandboxes (10 parallel) ──")
    NUM = 10
    sandbox_ids: list[str] = []
    create_errors: list[str] = []

    def create_and_exec(i: int) -> tuple[bool, str]:
        try:
            sb = fs.sandboxes.create(name=f"conc-{i}")
            sandbox_ids.append(sb.id)
            r = sb.exec(f"echo worker-{i}-done && sleep 0.1 && echo worker-{i}-finished")
            ok = r.ok and f"worker-{i}-done" in r.stdout and f"worker-{i}-finished" in r.stdout
            return ok, r.stdout
        except Exception as e:
            create_errors.append(str(e))
            return False, str(e)

    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=NUM) as pool:
        futures = {pool.submit(create_and_exec, i): i for i in range(NUM)}
        results = [(f.result(), i) for f, i in [(f, futures[f]) for f in as_completed(futures)]]
    elapsed = time.monotonic() - t0

    passed = [r for (r, _), _ in results if r]
    expect(f"all {NUM} concurrent sandboxes executed successfully", len(passed) == NUM, f"{len(passed)}/{NUM} passed")
    expect("no create/exec errors", len(create_errors) == 0, str(create_errors[:2]))
    print(f"    {INFO} {NUM} concurrent sandbox create+exec took {elapsed*1000:.0f} ms total")

    # cleanup
    cleanup_errors = []
    for sid in sandbox_ids:
        try:
            fs.sandboxes.delete(sid)
        except Exception as e:
            cleanup_errors.append(str(e))
    if cleanup_errors:
        print(f"    {INFO} cleanup errors: {cleanup_errors[:3]}")


def test_concurrent_exec_single_sandbox(fs: Client) -> None:
    """
    Fire many concurrent exec calls at ONE sandbox.
    The server's distributed RW lock must serialize writes without deadlock or data loss.
    With 5-req autoscale this should trigger replica scaling.
    """
    print("\n── 10. Concurrent exec on single sandbox (write-lock stress) ──")
    NUM_WORKERS = 12
    sb = fs.sandboxes.create(name="lock-stress")
    try:
        sb.exec("echo 0 > /home/user/n.txt")

        errors: list[str] = []
        latencies: list[float] = []

        def worker(i: int) -> bool:
            t0 = time.monotonic()
            try:
                r = sb.exec(
                    f"v=$(cat /home/user/n.txt 2>/dev/null || echo 0); echo $((v+1)) > /home/user/n.txt; echo done-{i}"
                )
                latencies.append((time.monotonic() - t0) * 1000)
                return r.ok and f"done-{i}" in r.stdout
            except Exception as e:
                errors.append(f"worker {i}: {e}")
                latencies.append((time.monotonic() - t0) * 1000)
                return False

        t0 = time.monotonic()
        with ThreadPoolExecutor(max_workers=NUM_WORKERS) as pool:
            outcomes = list(pool.map(worker, range(NUM_WORKERS)))
        wall_ms = (time.monotonic() - t0) * 1000

        succeeded = sum(outcomes)
        avg_ms = sum(latencies) / len(latencies) if latencies else 0
        p95_ms = sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0

        expect(f"all {NUM_WORKERS} write workers succeeded", succeeded == NUM_WORKERS, f"{succeeded}/{NUM_WORKERS}")
        expect("no lock errors", len(errors) == 0, str(errors[:3]))
        print(f"    {INFO} wall={wall_ms:.0f} ms  avg={avg_ms:.0f} ms  p95={p95_ms:.0f} ms")
    finally:
        sb.delete()


def test_concurrent_read_only_batch(fs: Client) -> None:
    """
    Multiple threads firing read_only exec_batch at the same sandbox in parallel.
    Should NOT serialize — all batches should overlap.
    """
    print("\n── 11. Concurrent read_only exec_batch (reader parallelism) ──")
    NUM_READERS = 8
    sb = fs.sandboxes.create(name="reader-stress")
    try:
        sb.exec("mkdir -p /home/user/data && for i in $(seq 1 20); do echo content_$i > /home/user/data/file_$i.txt; done")

        errors: list[str] = []
        latencies: list[float] = []

        def read_worker(i: int) -> bool:
            t0 = time.monotonic()
            try:
                results = sb.exec_batch(
                    [{"id": f"f{j}", "script": f"cat /home/user/data/file_{j}.txt"} for j in range(1, 6)],
                    timeout_ms=30_000,
                    read_only=True,
                )
                latencies.append((time.monotonic() - t0) * 1000)
                return all(r.ok and f"content_{j}" in r.stdout for r, j in zip(results, range(1, 6)))
            except Exception as e:
                errors.append(f"reader {i}: {e}")
                latencies.append((time.monotonic() - t0) * 1000)
                return False

        t0 = time.monotonic()
        with ThreadPoolExecutor(max_workers=NUM_READERS) as pool:
            outcomes = list(pool.map(read_worker, range(NUM_READERS)))
        wall_ms = (time.monotonic() - t0) * 1000

        succeeded = sum(outcomes)
        avg_ms = sum(latencies) / len(latencies) if latencies else 0
        expect(f"all {NUM_READERS} reader batches correct", succeeded == NUM_READERS, f"{succeeded}/{NUM_READERS}")
        expect("no read errors", len(errors) == 0, str(errors[:3]))
        print(f"    {INFO} {NUM_READERS} parallel read-batches: wall={wall_ms:.0f} ms  avg={avg_ms:.0f} ms")
    finally:
        sb.delete()


def test_mixed_rw_concurrency(fs: Client) -> None:
    """Writers and readers racing on the same sandbox simultaneously."""
    print("\n── 12. Mixed read/write concurrency ──")
    NUM_WRITERS = 4
    NUM_READERS = 8
    sb = fs.sandboxes.create(name="rw-mixed")
    try:
        sb.exec("echo 0 > /home/user/val.txt")

        errors: list[str] = []
        barrier = threading.Barrier(NUM_WRITERS + NUM_READERS)

        def writer(i: int) -> bool:
            barrier.wait()
            try:
                r = sb.exec(
                    f"v=$(cat /home/user/val.txt); echo $((v+1)) > /home/user/val.txt; echo w{i}"
                )
                return r.ok
            except Exception as e:
                errors.append(f"writer {i}: {e}")
                return False

        def reader(i: int) -> bool:
            barrier.wait()
            try:
                r = sb.exec("cat /home/user/val.txt", read_only=True)
                return r.ok and r.stdout.strip().isdigit()
            except Exception as e:
                errors.append(f"reader {i}: {e}")
                return False

        with ThreadPoolExecutor(max_workers=NUM_WRITERS + NUM_READERS) as pool:
            w_futures = [pool.submit(writer, i) for i in range(NUM_WRITERS)]
            r_futures = [pool.submit(reader, i) for i in range(NUM_READERS)]
            w_results = [f.result() for f in w_futures]
            r_results = [f.result() for f in r_futures]

        expect(f"all {NUM_WRITERS} writers succeeded", all(w_results), f"{sum(w_results)}/{NUM_WRITERS}")
        expect(f"all {NUM_READERS} readers succeeded", all(r_results), f"{sum(r_results)}/{NUM_READERS}")
        expect("no mixed-mode errors", len(errors) == 0, str(errors[:3]))

        final = int(sb.exec("cat /home/user/val.txt").stdout.strip())
        expect(f"counter = {NUM_WRITERS} after all writes", final == NUM_WRITERS, f"got {final}")
    finally:
        sb.delete()


def test_caching_correctness(fs: Client) -> None:
    """
    Write → read from same session (warm cache) vs fresh session.
    Ensures pathCache is invalidated correctly and reads are consistent.
    """
    print("\n── 13. Cache consistency ──")
    sb = fs.sandboxes.create(name="cache-test")
    try:
        # Write a file and immediately read it back (warm session, in-process cache)
        sb.exec("echo v1 > /home/user/data.txt")
        r1 = sb.exec("cat /home/user/data.txt", read_only=True)
        expect("warm read after write returns v1", "v1" in r1.stdout)

        # Overwrite and verify stale data is not served
        sb.exec("echo v2 > /home/user/data.txt")
        r2 = sb.exec("cat /home/user/data.txt", read_only=True)
        expect("warm read after overwrite returns v2 (not v1)", "v2" in r2.stdout and "v1" not in r2.stdout)

        # Create a new session (new Sandbox handle from fresh attach) and verify DB is source of truth
        sb2 = make_client().__enter__().sandboxes.attach(sb.id)
        r3 = sb2.exec("cat /home/user/data.txt", read_only=True)
        expect("fresh-attach session reads latest value (v2)", "v2" in r3.stdout)

        # pathCache: stat a file, delete it, verify not found (not served from stale cache)
        sb.exec("echo hello > /home/user/temp.txt")
        sb.exec("rm /home/user/temp.txt")
        r4 = sb.exec("ls /home/user/temp.txt 2>&1; echo exit:$?")
        expect("deleted file not in stale pathCache", "No such" in r4.stdout or "exit:1" in r4.stdout or r4.exit_code != 0)

        # contentCache: write multiple files, read them twice (second reads hit content cache)
        sb.exec("for i in $(seq 1 10); do echo content_line_$i > /home/user/cache_$i.txt; done")
        r5 = sb.exec("for i in $(seq 1 10); do cat /home/user/cache_$i.txt; done", read_only=True)
        r6 = sb.exec("for i in $(seq 1 10); do cat /home/user/cache_$i.txt; done", read_only=True)
        expect("multi-file read returns consistent content", r5.stdout == r6.stdout)
        expect("content has expected data (contentCache consistent)", "content_line_5" in r5.stdout and "content_line_10" in r5.stdout)
    finally:
        sb.delete()


def test_scaling_trigger(fs: Client) -> None:
    """
    Send a burst of >5 simultaneous exec calls to trigger autoscaling rule.
    Verifies all requests complete successfully even across replicas.
    """
    print("\n── 14. Autoscale trigger (burst > 5 concurrent bash reqs) ──")
    BURST = 15
    sandboxes: list[Sandbox] = []
    try:
        # Pre-create sandboxes so creation doesn't bottleneck the burst
        print(f"    {INFO} pre-creating {BURST} sandboxes …")
        with ThreadPoolExecutor(max_workers=BURST) as pool:
            sandboxes = list(pool.map(lambda i: fs.sandboxes.create(name=f"scale-{i}"), range(BURST)))

        errors: list[str] = []
        latencies: list[float] = []

        def fire(i: int) -> bool:
            sb = sandboxes[i]
            t0 = time.monotonic()
            try:
                r = sb.exec(f"echo scale-hit-{i} && sleep 1 && echo scale-done-{i}")
                latencies.append((time.monotonic() - t0) * 1000)
                return r.ok and f"scale-done-{i}" in r.stdout
            except Exception as e:
                errors.append(f"{i}: {e}")
                latencies.append((time.monotonic() - t0) * 1000)
                return False

        barrier = threading.Barrier(BURST)
        def fire_sync(i: int) -> bool:
            barrier.wait()  # all threads start simultaneously
            return fire(i)

        t0 = time.monotonic()
        with ThreadPoolExecutor(max_workers=BURST) as pool:
            outcomes = list(pool.map(fire_sync, range(BURST)))
        wall_ms = (time.monotonic() - t0) * 1000

        succeeded = sum(outcomes)
        avg_ms = sum(latencies) / len(latencies) if latencies else 0
        p95_ms = sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0

        expect(f"all {BURST} scaling-burst execs succeeded", succeeded == BURST, f"{succeeded}/{BURST} ok")
        expect("no errors during scale burst", len(errors) == 0, str(errors[:3]))
        print(f"    {INFO} burst={BURST}  wall={wall_ms:.0f} ms  avg={avg_ms:.0f} ms  p95={p95_ms:.0f} ms")
    finally:
        for sb in sandboxes:
            try:
                sb.delete()
            except Exception:
                pass


def test_sandbox_env_and_seed(fs: Client) -> None:
    print("\n── 15. Sandbox-level file seed + per-exec env ──")
    # sandbox-level env= does not inject into the bash session (just-bash only
    # exposes HOME/PATH/etc by default). Per-exec env= DOES work — verified in test 2.
    sb = fs.sandboxes.create(
        name="env-seed",
        files={"/home/user/seed.txt": "seeded-content\n"},
    )
    try:
        r2 = sb.exec("cat /home/user/seed.txt")
        expect("file seed created at sandbox level", "seeded-content" in r2.stdout)

        # Per-exec env injection (already tested in basics, but verify here for completeness)
        r3 = sb.exec("echo $MY_KEY", env={"MY_KEY": "my-value"})
        expect("per-exec env injection works", "my-value" in r3.stdout)

        # Verify per-exec env is scoped to that call only
        r4 = sb.exec("echo $MY_KEY")
        expect("per-exec env is not leaked to next call", r4.stdout.strip() == "")
    finally:
        sb.delete()


# ── runner ───────────────────────────────────────────────────────────────────

TESTS = [
    test_sandbox_lifecycle,
    test_exec_basics,
    test_file_operations,
    test_ingest_files,
    test_exec_batch,
    test_exec_streaming,
    test_error_handling,
    test_exec_atomicity,
    test_concurrent_sandboxes,
    test_concurrent_exec_single_sandbox,
    test_concurrent_read_only_batch,
    test_mixed_rw_concurrency,
    test_caching_correctness,
    test_scaling_trigger,
    test_sandbox_env_and_seed,
]


def main() -> None:
    print(f"SQL-FS live test suite")
    print(f"BASE_URL    : {BASE_URL}")
    print(f"AUTH_SECRET : {AUTH_SECRET[:8]}…")

    suite_start = time.monotonic()
    suite_errors: list[tuple[str, str]] = []

    with make_client() as fs:
        for fn in TESTS:
            try:
                fn(fs)
            except AssertionError:
                pass  # already recorded
            except Exception as e:
                name = fn.__name__
                tb = traceback.format_exc()
                suite_errors.append((name, tb))
                print(f"  {FAIL} {name} — unexpected exception: {e}")

    total = time.monotonic() - suite_start
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = sum(1 for _, ok, _ in _results if not ok)
    total_checks = passed + failed

    print(f"\n{'─'*60}")
    print(f"Results: {passed}/{total_checks} checks passed  ({total:.1f}s)")

    if failed:
        print(f"\nFailed checks:")
        for name, ok, note in _results:
            if not ok:
                print(f"  {FAIL} {name}" + (f" — {note}" if note else ""))

    if suite_errors:
        print(f"\nUnhandled exceptions in test functions:")
        for name, tb in suite_errors:
            print(f"\n  {name}:\n{tb}")

    sys.exit(0 if failed == 0 and not suite_errors else 1)


if __name__ == "__main__":
    main()
