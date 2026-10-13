from __future__ import annotations

import json

import httpx
import pytest
import respx

from sqlfs import Client
from sqlfs._http import Transport

BASE_URL = "https://api.test"


@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("code", ["EDRIVERFAULT", "EUNAVAILABLE", "08006"])
@respx.mock
def test_transient_read_retries_despite_conservative_server_flag(method, code):
    route = respx.route(method=method, url=f"{BASE_URL}/v1/sandboxes").mock(
        side_effect=[
            httpx.Response(
                503,
                json={"error": "database unavailable", "code": code, "retryable": False},
                headers={"Retry-After": "0"},
            ),
            httpx.Response(200, json={"sandboxes": []}),
        ]
    )
    transport = Transport(base_url=BASE_URL, token="t.k.n", max_retries=1)

    assert transport.request(method, "/sandboxes").status_code == 200
    assert route.call_count == 2


@pytest.mark.parametrize(
    ("code", "idempotent"),
    [("EDRIVERFAULT", False), ("EEXEC_OUTCOME_UNKNOWN", True)],
)
@respx.mock
def test_read_respects_explicit_no_retry_and_unknown_outcome(code, idempotent):
    from sqlfs import ServerError

    route = respx.get(f"{BASE_URL}/v1/sandboxes").mock(
        side_effect=[
            httpx.Response(
                503, json={"error": "operation failed", "code": code, "retryable": False}
            ),
            httpx.Response(200, json={"sandboxes": []}),
        ]
    )
    transport = Transport(base_url=BASE_URL, token="t.k.n", max_retries=1)

    with pytest.raises(ServerError) as exc:
        transport.request("GET", "/sandboxes", idempotent=idempotent)
    assert exc.value.code == code
    assert route.call_count == 1


@pytest.mark.parametrize(
    ("operation", "options"),
    [
        ("exec", {}),
        ("exec", {"retry_on_5xx": True}),
        ("exec", {"read_only": True}),
        ("batch", {"retry_on_5xx": True}),
        ("batch", {"read_only": True}),
        ("file", {}),
    ],
)
@respx.mock
def test_unknown_outcome_never_replays(operation, options):
    from sqlfs import ServerError

    method = "PUT" if operation == "file" else "POST"
    suffix = {
        "exec": "exec-sync",
        "batch": "exec-sync-batch",
        "file": "files/tmp/x",
    }[operation]
    route = respx.route(method=method, url=f"{BASE_URL}/v1/sandboxes/sb/{suffix}").mock(
        side_effect=[
            httpx.Response(
                503,
                json={
                    "error": "outcome unknown",
                    "code": "EEXEC_OUTCOME_UNKNOWN",
                    "retryable": False,
                },
            ),
            httpx.Response(200, json={"stdout": "replayed", "exitCode": 0}),
        ]
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    script = "cat /tmp/x" if options.get("read_only") else "mkdir -p /tmp/x"
    with pytest.raises(ServerError) as exc:
        if operation == "file":
            sb.fs.write("/tmp/x", "value")
        elif operation == "batch":
            sb.exec_batch([{"id": "a", "script": script}], **options)
        else:
            sb.exec(script, **options)
    assert exc.value.code == "EEXEC_OUTCOME_UNKNOWN"
    assert exc.value.status == 503
    assert route.call_count == 1


@pytest.mark.parametrize(
    ("code", "options"),
    [
        ("EWORKER_BUSY", {"retry_on_5xx": True}),
        ("EWORKER_BUSY", {"read_only": True}),
        ("EWORKER_UNAVAILABLE", {"read_only": True}),
        ("EUNAVAILABLE", {"retry_on_5xx": True}),
    ],
)
@respx.mock
def test_worker_retry_honors_authorization_and_retry_after(code, options, monkeypatch):
    from unittest.mock import Mock

    sleep = Mock()
    monkeypatch.setattr("sqlfs._http.time.sleep", sleep)
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec-sync").mock(
        side_effect=[
            httpx.Response(
                503,
                json={"error": "worker unavailable", "code": code, "retryable": True},
                headers={"Retry-After": "2"},
            ),
            httpx.Response(
                200,
                json={
                    "stdout": "ok\n",
                    "stderr": "",
                    "exitCode": 0,
                    "durationMs": 1,
                    "timedOut": False,
                },
            ),
        ]
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    script = "cat /tmp/x" if options.get("read_only") else "mkdir -p /tmp/x"
    assert sb.exec(script, **options).stdout == "ok\n"
    assert route.call_count == 2
    sleep.assert_called_once_with(2)


@pytest.mark.parametrize(
    ("code", "retryable"),
    [
        ("ELOCKLOST_APPLIED", False),
        ("EDRIVERFAULT", False),
        ("08006", False),
        ("EUNAVAILABLE", False),
        ("INTERNAL_ERROR", False),
        ("ELOCKLOST_APPLIED", None),
        ("EDRIVERFAULT", None),
        ("08006", None),
        ("EEXEC_OUTCOME_UNKNOWN", None),
    ],
)
@pytest.mark.parametrize(
    ("batch", "options"),
    [(False, {"read_only": True}), (True, {"retry_on_5xx": True})],
)
@respx.mock
def test_committed_or_unknown_response_never_replays(code, retryable, batch, options):
    from sqlfs import ServerError

    suffix = "exec-sync-batch" if batch else "exec-sync"
    body = {"error": "operation failed", "code": code}
    if retryable is not None:
        body["retryable"] = retryable
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/{suffix}").mock(
        side_effect=[
            httpx.Response(503, json=body),
            httpx.Response(200, json={"stdout": "replayed", "exitCode": 0}),
        ]
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    with pytest.raises(ServerError) as exc:
        if batch:
            sb.exec_batch([{"id": "a", "script": "mkdir -p /tmp/x"}], **options)
        else:
            sb.exec("cat /tmp/x", **options)
    assert [exc.value.code, exc.value.status] == [code, 503]
    assert route.call_count == 1


@respx.mock
def test_worker_busy_does_not_retry_write_without_authorization():
    from sqlfs import ServerError

    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec-sync").mock(
        return_value=httpx.Response(
            503, json={"error": "worker busy", "code": "EWORKER_BUSY", "retryable": True}
        )
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    with pytest.raises(ServerError) as exc:
        sb.exec("echo mutation >> /tmp/log")
    assert exc.value.code == "EWORKER_BUSY"
    assert route.call_count == 1


@pytest.mark.parametrize("operation", ["create", "exec", "batch"])
@respx.mock
def test_network_failure_does_not_replay_unsafe_writes(operation):
    from sqlfs import TransportError

    suffix = {
        "create": "",
        "exec": "/sb/exec-sync",
        "batch": "/sb/exec-sync-batch",
    }[operation]
    route = respx.post(f"{BASE_URL}/v1/sandboxes{suffix}").mock(
        side_effect=[
            httpx.ReadError("connection reset"),
            httpx.Response(
                200,
                json={
                    "stdout": "replayed",
                    "exitCode": 0,
                    "id": "duplicate",
                    "owner": "alice",
                    "createdAt": "2026-01-01T00:00:00Z",
                },
            ),
        ]
    )
    client = Client(base_url=BASE_URL, token="t.k.n", max_retries=1)
    sb = client.sandboxes.attach("sb")

    with pytest.raises(TransportError):
        if operation == "create":
            client.sandboxes.create()
        elif operation == "batch":
            sb.exec_batch([{"id": "a", "script": "echo mutation >> /tmp/log"}])
        else:
            sb.exec("echo mutation >> /tmp/log")
    assert route.call_count == 1


@pytest.mark.parametrize("operation", ["exec", "batch"])
@pytest.mark.parametrize(
    "options",
    [
        {"read_only": True},
        {"retry_on_5xx": True},
        {"read_only": True, "retry_on_5xx": True},
    ],
)
@pytest.mark.parametrize("failure", [httpx.ReadError, httpx.ReadTimeout])
@respx.mock
def test_network_failure_does_not_replay_scripts_with_retry_hints(operation, options, failure):
    from sqlfs import TransportError

    endpoint = "exec-sync-batch" if operation == "batch" else "exec-sync"
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/{endpoint}").mock(
        side_effect=[
            failure("connection lost after script dispatch"),
            httpx.Response(200, json={"stdout": "replayed\n", "exitCode": 0}),
        ]
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    script = "curl -X POST https://example.test/effect"
    with pytest.raises(TransportError, match="network error after 1 attempts"):
        if operation == "batch":
            sb.exec_batch([{"id": "a", "script": script}], **options)
        else:
            sb.exec(script, **options)
    assert route.call_count == 1


@respx.mock
def test_network_failure_retries_read_request():
    route = respx.get(f"{BASE_URL}/v1/sandboxes/sb/files/tmp/x").mock(
        side_effect=[
            httpx.ReadError("connection reset"),
            httpx.Response(200, content=b"persisted"),
        ]
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    assert sb.fs.read("/tmp/x").content == b"persisted"
    assert route.call_count == 2


@pytest.mark.parametrize("operation", ["exec", "batch"])
@pytest.mark.parametrize("options", [{"read_only": True}, {"retry_on_5xx": True}])
@pytest.mark.parametrize(
    ("status", "body"),
    [
        (429, json.dumps({"error": "rate limited"})),
        (500, json.dumps({"error": "internal error"})),
        (502, "<html>Bad gateway</html>"),
        (503, json.dumps({"error": "busy", "code": "ERUNTIME_BUSY"})),
        (504, "<html>Gateway timeout</html>"),
        (503, json.dumps({"error": "busy", "code": "EWORKER_BUSY", "retryable": "true"})),
    ],
)
@respx.mock
def test_ambiguous_http_response_never_replays_scripts(status, body, operation, options):
    from sqlfs import SQLFSError

    endpoint = "exec-sync-batch" if operation == "batch" else "exec-sync"
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/{endpoint}").mock(
        side_effect=[
            httpx.Response(status, content=body),
            httpx.Response(200, json={"stdout": "replayed", "exitCode": 0}),
        ]
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")
    script = "curl -X POST https://example.test/effect"

    with pytest.raises(SQLFSError) as exc:
        if operation == "batch":
            sb.exec_batch([{"id": "a", "script": script}], **options)
        else:
            sb.exec(script, **options)
    assert exc.value.status == status
    assert route.call_count == 1


@respx.mock
def test_legacy_transient_http_failure_retries_file_read():
    route = respx.get(f"{BASE_URL}/v1/sandboxes/sb/files/tmp/x").mock(
        side_effect=[
            httpx.Response(502, content="Bad gateway"),
            httpx.Response(200, content=b"persisted"),
        ]
    )
    sb = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    assert sb.fs.read("/tmp/x").content == b"persisted"
    assert route.call_count == 2
