"""Unit tests for the VirtualFS SDK.

Mocks httpx with respx — no network required.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest
import respx

from virtualfs import (
    AuthError,
    Client,
    ConflictError,
    ExecTimeoutError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)

BASE_URL = "https://api.test"


def make_client(**overrides) -> Client:
    kwargs = dict(base_url=BASE_URL, token="t.k.n", max_retries=0)
    kwargs.update(overrides)
    return Client(**kwargs)


# ── Auth bootstrap ───────────────────────────────────────────────────────────
@respx.mock
def test_bootstrap_exchanges_auth_secret_for_token():
    route = respx.post(f"{BASE_URL}/v1/auth/bootstrap").mock(
        return_value=httpx.Response(
            201, json={"token": "minted-jwt", "sub": "alice", "expiresAt": None}
        )
    )
    c = Client(base_url=BASE_URL, auth_secret="s3cret", sub="alice", max_retries=0)
    assert c.token == "minted-jwt"
    assert route.called
    sent = json.loads(route.calls[0].request.content.decode())
    assert sent == {"sub": "alice", "expiresIn": "30d"}
    assert route.calls[0].request.headers["X-Auth-Secret"] == "s3cret"


@respx.mock
def test_bootstrap_admin_secret_uses_admin_endpoint():
    respx.post(f"{BASE_URL}/v1/auth/admin").mock(
        return_value=httpx.Response(201, json={"token": "admin-jwt", "sub": "root"})
    )
    c = Client(base_url=BASE_URL, admin_secret="adm", sub="root", max_retries=0)
    assert c.token == "admin-jwt"


def test_constructor_requires_credentials():
    with pytest.raises(ValueError, match="Provide one of"):
        Client(base_url=BASE_URL)


def test_constructor_requires_sub_with_secret():
    with pytest.raises(ValueError, match="`sub` is required"):
        Client(base_url=BASE_URL, auth_secret="x")


# ── Sandboxes CRUD ───────────────────────────────────────────────────────────
@respx.mock
def test_list_sandboxes():
    respx.get(f"{BASE_URL}/v1/sandboxes").mock(
        return_value=httpx.Response(
            200,
            json={
                "sandboxes": [
                    {
                        "id": "id-1",
                        "name": "a",
                        "owner": "alice",
                        "createdAt": "2026-01-01T00:00:00Z",
                        "python": True,
                        "javascript": False,
                    }
                ]
            },
        )
    )
    sandboxes = make_client().sandboxes.list()
    assert len(sandboxes) == 1
    assert sandboxes[0].id == "id-1"
    assert sandboxes[0].python is True


@respx.mock
def test_create_sandbox_returns_handle():
    respx.post(f"{BASE_URL}/v1/sandboxes").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": "sb-9",
                "name": "demo",
                "owner": "alice",
                "createdAt": "2026-01-01T00:00:00Z",
                "python": False,
                "javascript": False,
            },
        )
    )
    sb = make_client().sandboxes.create(name="demo", env={"FOO": "bar"})
    assert sb.id == "sb-9"
    assert sb.record is not None and sb.record.name == "demo"


@respx.mock
def test_create_sandbox_with_network_passes_flag():
    """`network=True` is forwarded to the create payload so js-exec `fetch()` can be enabled."""
    route = respx.post(f"{BASE_URL}/v1/sandboxes").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": "sb-net",
                "name": None,
                "owner": "alice",
                "createdAt": "2026-01-01T00:00:00Z",
                "python": False,
                "javascript": True,
            },
        )
    )
    make_client().sandboxes.create(javascript=True, network=True)
    assert route.called
    sent = json.loads(route.calls.last.request.content)
    assert sent.get("network") is True
    assert sent.get("javascript") is True


@respx.mock
def test_create_sandbox_network_default_omitted():
    """When `network` is not requested, the flag must not leak into the body (default secure)."""
    route = respx.post(f"{BASE_URL}/v1/sandboxes").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": "sb-x",
                "name": None,
                "owner": "alice",
                "createdAt": "2026-01-01T00:00:00Z",
                "python": False,
                "javascript": False,
            },
        )
    )
    make_client().sandboxes.create()
    assert route.called
    body = route.calls.last.request.content
    # Empty body is also fine — what matters is that `network` is not asserted as True
    if body:
        sent = json.loads(body)
        assert "network" not in sent or sent["network"] is False


@respx.mock
def test_get_sandbox_404_raises_notfound():
    respx.get(f"{BASE_URL}/v1/sandboxes/missing").mock(
        return_value=httpx.Response(404, json={"error": "not_found", "code": "ENOENT"})
    )
    with pytest.raises(NotFoundError) as exc_info:
        make_client().sandboxes.get("missing")
    assert exc_info.value.code == "ENOENT"
    assert exc_info.value.status == 404


@respx.mock
def test_delete_sandbox():
    route = respx.delete(f"{BASE_URL}/v1/sandboxes/sb-9").mock(return_value=httpx.Response(204))
    make_client().sandboxes.delete("sb-9")
    assert route.called


# ── Files ────────────────────────────────────────────────────────────────────
@respx.mock
def test_read_file_with_stat_header():
    stat_header = json.dumps(
        {"kind": "file", "mode": 0o644, "size": 5, "mtime": "2026-01-01T00:00:00Z"}
    )
    respx.get(f"{BASE_URL}/v1/sandboxes/sb/files/home/user/x.txt").mock(
        return_value=httpx.Response(
            200,
            content=b"hello",
            headers={"X-FS-Stat": stat_header, "Content-Type": "text/plain"},
        )
    )
    sb = make_client().sandboxes.attach("sb")
    r = sb.fs.read("/home/user/x.txt")
    assert r.content == b"hello"
    assert r.text() == "hello"
    assert r.stat is not None and r.stat.size == 5


@respx.mock
def test_write_file_sends_octet_stream():
    route = respx.put(f"{BASE_URL}/v1/sandboxes/sb/files/a/b.txt").mock(
        return_value=httpx.Response(204)
    )
    sb = make_client().sandboxes.attach("sb")
    sb.fs.write("/a/b.txt", "hello")
    assert route.called
    req = route.calls[0].request
    assert req.headers["Content-Type"] == "application/octet-stream"
    assert req.content == b"hello"


@respx.mock
def test_write_files_bulk():
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/writeFiles").mock(
        return_value=httpx.Response(204)
    )
    sb = make_client().sandboxes.attach("sb")
    sb.fs.write_files({"/a.txt": "1", "/b.txt": "2"})
    sent = json.loads(route.calls[0].request.content.decode())
    assert sent == {"files": {"/a.txt": "1", "/b.txt": "2"}}


@respx.mock
def test_delete_recursive_passes_query_param():
    route = respx.delete(
        f"{BASE_URL}/v1/sandboxes/sb/files/dir", params={"recursive": "true"}
    ).mock(return_value=httpx.Response(204))
    sb = make_client().sandboxes.attach("sb")
    sb.fs.delete("/dir", recursive=True)
    assert route.called


@respx.mock
def test_delete_nonempty_dir_raises_conflict():
    respx.delete(f"{BASE_URL}/v1/sandboxes/sb/files/dir").mock(
        return_value=httpx.Response(409, json={"error": "conflict", "code": "ENOTEMPTY"})
    )
    sb = make_client().sandboxes.attach("sb")
    with pytest.raises(ConflictError) as exc:
        sb.fs.delete("/dir")
    assert exc.value.code == "ENOTEMPTY"


@respx.mock
def test_mkdir_with_recursive():
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/mkdir").mock(return_value=httpx.Response(204))
    sb = make_client().sandboxes.attach("sb")
    sb.fs.mkdir("/a/b/c", recursive=True)
    sent = json.loads(route.calls[0].request.content.decode())
    assert sent == {"path": "/a/b/c", "recursive": True}


@respx.mock
def test_tree_returns_typed_entries():
    respx.get(f"{BASE_URL}/v1/sandboxes/sb/tree").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"path": "/a", "kind": "dir", "size": 0, "mtime": "t"},
                {"path": "/a/b.txt", "kind": "file", "size": 5, "mtime": "t"},
            ],
        )
    )
    sb = make_client().sandboxes.attach("sb")
    entries = sb.fs.tree(prefix="/a", depth=2)
    assert [e.kind for e in entries] == ["dir", "file"]


# ── Exec ─────────────────────────────────────────────────────────────────────
@respx.mock
def test_exec_returns_flat_result():
    respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec-sync").mock(
        return_value=httpx.Response(
            200,
            json={
                "stdout": "hi\n",
                "stderr": "",
                "exitCode": 0,
                "exitSignal": None,
                "timedOut": False,
                "durationMs": 12,
            },
        )
    )
    sb = make_client().sandboxes.attach("sb")
    r = sb.exec("echo hi")
    assert r.stdout == "hi\n"
    assert r.error == ""  # alias for stderr
    assert r.exit_code == 0
    assert r.ok is True
    assert r.duration_ms == 12


@respx.mock
def test_exec_timeout_raises_typed_exception():
    respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec-sync").mock(
        return_value=httpx.Response(
            408,
            json={
                "error": "timeout",
                "code": "ETIMEDOUT",
                "timedOut": True,
                "durationMs": 30000,
            },
        )
    )
    sb = make_client().sandboxes.attach("sb")
    with pytest.raises(ExecTimeoutError) as exc:
        sb.exec("sleep 60", timeout_ms=30_000)
    assert exc.value.duration_ms == 30000


@respx.mock
def test_exec_batch():
    respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec-sync-batch").mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {"id": "a", "stdout": "1", "stderr": "", "exitCode": 0},
                    {"id": "b", "stdout": "", "stderr": "boom", "exitCode": 2},
                ]
            },
        )
    )
    sb = make_client().sandboxes.attach("sb")
    results = sb.exec_batch([{"id": "a", "script": "echo 1"}, {"id": "b", "script": "false"}])
    assert [r.id for r in results] == ["a", "b"]
    assert results[0].ok is True
    assert results[1].ok is False


@respx.mock
def test_exec_stream_yields_events_until_exit():
    sse_body = (
        'event: stdout\ndata: {"t":0.1,"data":"hello\\n"}\n\n'
        'event: stderr\ndata: {"t":0.2,"data":"warn\\n"}\n\n'
        'event: exit\ndata: {"t":0.3,"exitCode":0,"durationMs":42}\n\n'
    )
    respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec").mock(
        return_value=httpx.Response(
            200, content=sse_body.encode(), headers={"Content-Type": "text/event-stream"}
        )
    )
    sb = make_client().sandboxes.attach("sb")
    events = list(sb.exec_stream("echo hello"))
    assert [e.type for e in events] == ["stdout", "stderr", "exit"]
    assert events[0].data == "hello\n"
    assert events[2].exit_code == 0
    assert events[2].duration_ms == 42


# ── Ingest / Export ──────────────────────────────────────────────────────────
@respx.mock
def test_ingest_files_base64_encodes():
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/ingest-files").mock(
        return_value=httpx.Response(200, json={"status": "ok", "fileCount": 2})
    )
    sb = make_client().sandboxes.attach("sb")
    sb.ingest_files({"a.txt": "hello", "b.bin": b"\x00\x01"}, base_path="/home/user/p")
    sent = json.loads(route.calls[0].request.content.decode())
    assert sent["basePath"] == "/home/user/p"
    assert sent["files"]["a.txt"] == base64.b64encode(b"hello").decode()
    assert sent["files"]["b.bin"] == base64.b64encode(b"\x00\x01").decode()


@respx.mock
def test_export_returns_bytes():
    blob = b"\x1f\x8b\x08\x00fake.tar.gz"
    respx.get(f"{BASE_URL}/v1/sandboxes/sb/export").mock(
        return_value=httpx.Response(200, content=blob)
    )
    sb = make_client().sandboxes.attach("sb")
    assert sb.export(base_path="/home/user") == blob


# ── Error mapping ────────────────────────────────────────────────────────────
@respx.mock
def test_400_maps_to_validation_error():
    respx.post(f"{BASE_URL}/v1/sandboxes").mock(
        return_value=httpx.Response(400, json={"error": "bad", "code": "EINVAL", "details": ["x"]})
    )
    with pytest.raises(ValidationError) as exc:
        make_client().sandboxes.create(name="x")
    assert exc.value.details == ["x"]


@respx.mock
def test_403_maps_to_auth_error():
    respx.get(f"{BASE_URL}/v1/sandboxes").mock(
        return_value=httpx.Response(403, json={"error": "forbidden", "code": "EPERM"})
    )
    with pytest.raises(AuthError):
        make_client().sandboxes.list()


@respx.mock
def test_429_maps_to_rate_limit_with_retry_after():
    respx.get(f"{BASE_URL}/v1/sandboxes").mock(
        return_value=httpx.Response(
            429,
            json={"error": "rate_limited", "code": "ERATELIMIT"},
            headers={"Retry-After": "7"},
        )
    )
    with pytest.raises(RateLimitError) as exc:
        make_client().sandboxes.list()
    assert exc.value.retry_after == 7
