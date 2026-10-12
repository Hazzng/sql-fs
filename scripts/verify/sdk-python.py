import json
import os
import sys
import time
from hashlib import sha256

import httpx
from sqlfs import Client, NotFoundError, ServerError, ValidationError

requests = []
checks = []


def equal(actual, expected, label):
    assert actual == expected, f"{label}: {actual!r} != {expected!r}"
    checks.append(label)


def observe(response):
    entry = {
        "method": response.request.method,
        "path": response.request.url.path,
        "status": response.status_code,
        "at": time.monotonic(),
        "retryAfter": response.headers.get("Retry-After"),
    }
    if response.status_code >= 400:
        response.read()
        body = response.json()
        entry.update(code=body.get("code"), retryable=body.get("retryable"))
    requests.append(entry)


mode = sys.argv[1]
with httpx.Client(event_hooks={"response": [observe]}) as http:
    with Client(
        base_url=os.environ["SDK_VERIFY_BASE_URL"],
        token=os.environ["SDK_VERIFY_TOKEN"] if mode != "normal" else None,
        auth_secret=os.environ["AUTH_SECRET"] if mode == "normal" else None,
        sub=os.environ["SDK_VERIFY_SUB"],
        max_retries=1,
        http_client=http,
    ) as client:
        if mode == "normal":
            sandbox = client.sandboxes.create(
                name="python-sdk-verification", files={"/home/user/seed.txt": "seed\n"}
            )
            equal(
                client.sandboxes.get(sandbox.id).id,
                sandbox.id,
                "Python sandbox metadata",
            )
            equal(
                any(item.id == sandbox.id for item in client.sandboxes.list()),
                True,
                "Python sandbox listed",
            )
            equal(
                sandbox.fs.read("/home/user/seed.txt").text(),
                "seed\n",
                "Python seeded bytes",
            )
            sandbox.fs.mkdir("/home/user/sdk", recursive=True)
            binary = bytes([0, 1, 10, 127, 128, 255])
            sandbox.fs.write("/home/user/sdk/binary.bin", binary)
            read = sandbox.fs.read("/home/user/sdk/binary.bin")
            equal(read.content, binary, "Python binary round trip")
            equal([read.stat.kind, read.stat.size], ["file", 6], "Python binary stat")
            sandbox.fs.write_files(
                {"/home/user/sdk/a.txt": "A", "/home/user/sdk/b.txt": "B"}
            )
            sandbox.ingest_files(
                {"nested/ingested.txt": "ingested"}, base_path="/home/user/sdk"
            )
            equal(
                sandbox.fs.read("/home/user/sdk/nested/ingested.txt").text(),
                "ingested",
                "Python ingest persisted",
            )
            result = sandbox.exec(
                "printf '%s' \"$SDK_VALUE\" > /home/user/sdk/bash.txt; cat /home/user/sdk/bash.txt",
                env={"SDK_VALUE": "python-bash"},
            )
            equal(
                [result.exit_code, result.stdout],
                [0, "python-bash"],
                "Python Bash result",
            )
            equal(
                sandbox.fs.read("/home/user/sdk/bash.txt").text(),
                "python-bash",
                "Python Bash persisted",
            )
            batch = sandbox.exec_batch(
                [
                    {"id": "a", "script": "cat /home/user/sdk/a.txt"},
                    {"id": "b", "script": "cat /home/user/sdk/b.txt"},
                ],
                read_only=True,
            )
            equal(
                [[item.id, item.exit_code, item.stdout] for item in batch],
                [["a", 0, "A"], ["b", 0, "B"]],
                "Python read-only batch",
            )
            try:
                sandbox.exec("echo denied > /home/user/sdk/denied.txt", read_only=True)
                raise AssertionError("Python read-only write succeeded")
            except ValidationError as error:
                equal(error.code, "EREADONLY_VIOLATION", "Python read-only rejection")
            try:
                sandbox.fs.read("/home/user/sdk/denied.txt")
                raise AssertionError("Python rejected write persisted")
            except NotFoundError:
                checks.append("Python rejected write remains absent")
            events = list(
                sandbox.exec_stream("printf 'stream-out'; printf 'stream-err' >&2")
            )
            equal(
                "".join(event.data or "" for event in events if event.type == "stdout"),
                "stream-out",
                "Python SSE stdout",
            )
            equal(
                "".join(event.data or "" for event in events if event.type == "stderr"),
                "stream-err",
                "Python SSE stderr",
            )
            equal(
                [events[-1].type, events[-1].exit_code],
                ["exit", 0],
                "Python SSE terminal",
            )
            tree = sandbox.fs.tree(prefix="/home/user/sdk", depth=3)
            equal(
                any(item.path.endswith("/binary.bin") for item in tree),
                True,
                "Python tree bytes",
            )
            sandbox.fs.delete("/home/user/sdk", recursive=True)
            sandbox.delete()
            equal(client.sandboxes.list(), [], "Python SDK lifecycle cleanup")
        elif mode == "large-ingest":
            sandbox = client.sandboxes.create()
            content = b"Z" * (
                int(os.environ.get("SDK_VERIFY_INGEST_MIB", "16")) * 1024 * 1024
            )
            sandbox.ingest_files({"large.bin": content}, base_path="/home/user/sdk")
            with Client(
                base_url=os.environ["SDK_VERIFY_BASE_URL"],
                auth_secret=os.environ["AUTH_SECRET"],
                sub=os.environ["SDK_VERIFY_SUB"],
                max_file_size=8 * 1024 * 1024,
                http_client=http,
            ) as limited:
                for allow_oversized in (False, True):
                    before = len(requests)
                    try:
                        limited.sandboxes.attach(sandbox.id).ingest_files(
                            {"large.bin": content}, allow_oversized=allow_oversized
                        )
                        raise AssertionError(
                            "Python explicit file limit accepted oversized input"
                        )
                    except ValidationError as error:
                        equal(
                            error.code,
                            "EFILE_TOO_LARGE",
                            "Python explicit file limit code",
                        )
                    equal(
                        len(requests),
                        before,
                        "Python explicit file limit rejects before network",
                    )
            print(
                json.dumps(
                    {
                        "sandboxId": sandbox.id,
                        "bytes": len(content),
                        "sha256": sha256(content).hexdigest(),
                        "checks": checks,
                        "requests": requests,
                    }
                )
            )
            sys.exit(0)
        elif mode in {"unknown", "readonly-unknown", "stream-unknown"}:
            sandbox = client.sandboxes.create(
                files={"/home/user/outcome.txt": "before\n"}
            )
            prefix = (
                ""
                if mode == "readonly-unknown"
                else "printf 'once\\n' >> /home/user/outcome.txt; "
            )
            script = (
                prefix + f"printf '{os.environ['SDK_VERIFY_MARKER']}:crash\\n'; sleep 5"
            )
            try:
                if mode == "stream-unknown":
                    list(sandbox.exec_stream(script))
                else:
                    sandbox.exec(
                        script, retry_on_5xx=True, read_only=mode == "readonly-unknown"
                    )
                raise AssertionError("Python worker death was acknowledged as success")
            except ServerError as error:
                equal(
                    [error.code, error.status],
                    ["EEXEC_OUTCOME_UNKNOWN", 503],
                    f"Python {mode} outcome",
                )
                equal(error.retryable, False, f"Python {mode} typed retry policy")
            attempts = [
                item
                for item in requests
                if item["path"].endswith(
                    "/exec" if mode == "stream-unknown" else "/exec-sync"
                )
            ]
            equal(len(attempts), 1, f"Python never replays {mode} outcome")
            if mode != "stream-unknown":
                equal(
                    attempts[0]["retryable"], False, f"Python {mode} is not retryable"
                )
            print(
                json.dumps(
                    {"sandboxId": sandbox.id, "checks": checks, "requests": requests}
                )
            )
            sys.exit(0)
        elif mode == "busy":
            sandbox = client.sandboxes.attach(os.environ["SDK_VERIFY_SANDBOX_ID"])
            equal(
                sandbox.exec("printf 'busy-retry-ok'", retry_on_5xx=True).stdout,
                "busy-retry-ok",
                "Python busy retry result",
            )
            attempts = [
                item for item in requests if item["path"].endswith("/exec-sync")
            ]
            equal(len(attempts), 2, "Python busy uses exactly one retry")
            equal(
                [attempts[0]["status"], attempts[0]["code"], attempts[0]["retryable"]],
                [503, "EWORKER_BUSY", True],
                "Python busy predispatch contract",
            )
            wait = int(attempts[0]["retryAfter"])
            equal(wait >= 1, True, "Python busy retry guidance")
            equal(
                attempts[1]["at"] - attempts[0]["at"] >= wait,
                True,
                "Python honors Retry-After",
            )
        else:
            raise AssertionError(f"Unknown SDK verification mode {mode}")

print(json.dumps({"checks": checks, "requests": requests}))
