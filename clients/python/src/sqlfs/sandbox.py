"""`Sandbox` handle — bound to a specific sandbox id, exposes the full API.

Get one via:

    client = Client(...)
    sb = client.sandboxes.create(name="my-project")
    # or:
    sb = client.sandboxes.attach("550e8400-...")

Then call:

    sb.exec("echo hi")              # → ExecResult
    sb.exec_batch([...])            # → list[BatchExecResult]
    for ev in sb.exec_stream(...):  # SSE
        ...

    sb.fs.read("/home/user/x.py")   # → ReadResult (.content / .text())
    sb.fs.write("/home/user/x", "hi")
    sb.fs.write_files({...})
    sb.fs.delete(...)
    sb.fs.mkdir(...)
    sb.fs.tree(prefix=..., depth=...)

    sb.ingest_files({"a.txt": b"..."}, base_path="/home/user/p")
    sb.delete()
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator, Mapping
from typing import Any, Dict, List, Optional, Union

from ._http import Transport, encode_path, iter_sse_events
from .errors import ValidationError
from .models import (
    BatchExecResult,
    ExecResult,
    FileStat,
    ReadResult,
    SandboxRecord,
    StreamEvent,
    TreeEntry,
)

#: Default per-file size ceiling (bytes) enforced client-side before any
#: content is base64-encoded or sent over the network. 64 MiB. Override per
#: client via ``Client(max_file_size=...)`` or disable with ``max_file_size=0``.
DEFAULT_MAX_FILE_SIZE = 64 * 1024 * 1024


def _content_size(content: Union[str, bytes]) -> int:
    """Raw byte length of a write payload (``str`` measured as UTF-8)."""
    return len(content.encode("utf-8")) if isinstance(content, str) else len(content)


def _enforce_max_file_size(
    files: Mapping[str, Union[str, bytes]],
    max_file_size: int,
) -> None:
    """Reject oversized files *before* anything is encoded or sent.

    Raises ``ValidationError`` (code ``EFILE_TOO_LARGE``) naming every offending
    path and its size. A ``max_file_size`` of 0 (or negative) disables the check.
    """
    if max_file_size <= 0:
        return
    too_big = [
        (path, size)
        for path, content in files.items()
        if (size := _content_size(content)) > max_file_size
    ]
    if too_big:
        details = [f"{path} ({size} bytes > {max_file_size} limit)" for path, size in too_big]
        raise ValidationError(
            "file exceeds max_file_size: " + "; ".join(details),
            code="EFILE_TOO_LARGE",
            details=details,
        )


class FilesAPI:
    """`sandbox.fs.*` — file operations on a single sandbox."""

    def __init__(
        self,
        transport: Transport,
        sandbox_id: str,
        max_file_size: int = DEFAULT_MAX_FILE_SIZE,
    ) -> None:
        self._t = transport
        self._id = sandbox_id
        self._max_file_size = max_file_size

    def read(self, path: str) -> ReadResult:
        """`GET /files/{path}` — read raw bytes + parsed `X-FS-Stat` header."""
        resp = self._t.request(
            "GET",
            f"/sandboxes/{self._id}/files/{encode_path(path)}",
            expect_json=False,
        )
        stat: Optional[FileStat] = None
        raw = resp.headers.get("X-FS-Stat")
        if raw:
            try:
                stat = FileStat.from_api(json.loads(raw))
            except (json.JSONDecodeError, KeyError, ValueError):
                stat = None
        return ReadResult(content=resp.content, stat=stat)

    def read_text(self, path: str, encoding: str = "utf-8") -> str:
        """Convenience: read + decode as text."""
        return self.read(path).text(encoding)

    def write(self, path: str, content: Union[str, bytes]) -> None:
        """`PUT /files/{path}` — write raw bytes; parents auto-created."""
        _enforce_max_file_size({path: content}, self._max_file_size)
        body = content.encode("utf-8") if isinstance(content, str) else content
        self._t.request(
            "PUT",
            f"/sandboxes/{self._id}/files/{encode_path(path)}",
            content=body,
            headers={"Content-Type": "application/octet-stream"},
            expect_json=False,
        )

    def write_files(self, files: Mapping[str, str]) -> None:
        """`POST /writeFiles` — write multiple files in one round-trip.

        Keys are absolute paths inside the sandbox, values are file contents
        (text). For binary content, prefer `ingest_files()` (base64).
        """
        _enforce_max_file_size(files, self._max_file_size)
        self._t.request(
            "POST",
            f"/sandboxes/{self._id}/writeFiles",
            json_body={"files": dict(files)},
            expect_json=False,
        )

    def delete(self, path: str, *, recursive: bool = False) -> None:
        """`DELETE /files/{path}` — delete file or directory.

        For directories, set `recursive=True` to delete contents too.
        """
        params = {"recursive": "true"} if recursive else None
        self._t.request(
            "DELETE",
            f"/sandboxes/{self._id}/files/{encode_path(path)}",
            params=params,
            expect_json=False,
        )

    def mkdir(self, path: str, *, recursive: bool = False) -> None:
        """`POST /mkdir` — create a directory (optionally `mkdir -p`)."""
        self._t.request(
            "POST",
            f"/sandboxes/{self._id}/mkdir",
            json_body={"path": path, "recursive": recursive},
            expect_json=False,
        )

    def tree(
        self,
        *,
        prefix: Optional[str] = None,
        depth: Optional[int] = None,
    ) -> List[TreeEntry]:
        """`GET /tree` — list entries under `prefix`, up to `depth` deep."""
        params: Dict[str, Any] = {}
        if prefix is not None:
            params["prefix"] = prefix
        if depth is not None:
            params["depth"] = depth
        resp = self._t.request("GET", f"/sandboxes/{self._id}/tree", params=params)
        body = resp.json()
        if not isinstance(body, list):
            return []
        return [TreeEntry.from_api(item) for item in body]


class Sandbox:
    """A sandbox handle. Use `Client.sandboxes.create()` or `.attach()`."""

    def __init__(
        self,
        transport: Transport,
        sandbox_id: str,
        *,
        record: Optional[SandboxRecord] = None,
        max_file_size: int = DEFAULT_MAX_FILE_SIZE,
    ) -> None:
        self._t = transport
        self._id = sandbox_id
        self._record = record
        self._max_file_size = max_file_size
        self.fs = FilesAPI(transport, sandbox_id, max_file_size)

    @property
    def id(self) -> str:
        return self._id

    @property
    def record(self) -> Optional[SandboxRecord]:
        """The full record returned at creation. None for attached sandboxes."""
        return self._record

    def __repr__(self) -> str:
        return f"Sandbox(id={self._id!r})"

    # ── exec ────────────────────────────────────────────────────────────────
    def exec(
        self,
        script: str,
        *,
        cwd: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        timeout_ms: int = 30_000,
        debug: bool = False,
        read_only: bool = False,
        retry_on_5xx: bool = False,
    ) -> ExecResult:
        """`POST /exec-sync` — run a bash script and return the buffered result.

        The sandbox-level lock is held for the entire duration of this call.
        All reads, computes, and writes that must be atomic relative to other
        callers MUST be bundled into a single script. Two separate `exec` calls
        are two separate lock acquisitions — another agent can slip in between:

            # WRONG — race between read and write
            balance = int(sb.exec("cat balance.txt").stdout)
            sb.exec(f"echo {balance - 50} > balance.txt")  # another agent may have written here

            # CORRECT — lock held for the whole operation
            sb.exec("balance=$(cat balance.txt); echo $((balance - 50)) > balance.txt")

        Retry semantics:
          - `read_only=True` execs are always safe to retry; the SDK retries
            transient 5xx automatically regardless of `retry_on_5xx`.
          - For write execs, the SDK does NOT retry 5xx by default — retrying
            a write that may have committed could double-apply side effects.
            Set `retry_on_5xx=True` to opt in only when the script is
            idempotent (e.g. `mkdir -p`, deterministic `echo > file`).
          - 503 `ECOHERENCE` is never retried on write execs even when
            `retry_on_5xx=True`: the write committed to Postgres and only
            the Redis publish failed.
        """
        body: Dict[str, Any] = {"script": script, "timeoutMs": timeout_ms}
        if cwd is not None:
            body["cwd"] = cwd
        if env is not None:
            body["env"] = dict(env)
        if debug:
            body["debug"] = True
        if read_only:
            body["readOnly"] = True
        if retry_on_5xx:
            body["retryOn5xx"] = True

        # Wall-clock httpx timeout slightly above server-side budget so a
        # legitimate timeout surfaces as 408 rather than a transport error.
        client_timeout = max(timeout_ms / 1000.0 + 5.0, 35.0)
        resp = self._t.request(
            "POST",
            f"/sandboxes/{self._id}/exec-sync",
            json_body=body,
            timeout=client_timeout,
            idempotent=read_only or retry_on_5xx,
            read_only=read_only,
        )
        return ExecResult.from_api(resp.json())

    def exec_batch(
        self,
        scripts: List[Mapping[str, str]],
        *,
        timeout_ms: int = 30_000,
        per_script_timeout_ms: Optional[int] = None,
        read_only: bool = False,
        retry_on_5xx: bool = False,
    ) -> List[BatchExecResult]:
        """`POST /exec-sync-batch` — run up to 50 scripts in one HTTP request.

        `scripts` is a list of `{"id": "...", "script": "..."}` dicts. The
        single `timeout_ms` budget covers all scripts; if it is exhausted,
        the remaining results carry `exit_code=-1` and `error="timeout"`.

        `per_script_timeout_ms`: optional per-script budget (ms). When set,
        each script gets its own independent timeout instead of sharing
        `timeout_ms`. The outer `timeout_ms` still acts as an absolute ceiling.
        Recommended for capability probes (`python3 -c 'import foo'` x N)
        where a slow first script would otherwise silently exhaust the shared
        budget and turn later scripts into false negatives.

        Execution mode (important — agents please read):

        * `read_only=False` (default): scripts run **SEQUENTIALLY** inside a
          single write-lock acquisition. They share shell state and are
          atomic relative to other callers. This collapses N HTTP round-trips
          into 1 but does **not** parallelise CPU-bound work — each script
          waits for the previous to finish.
        * `read_only=True`: scripts run **IN PARALLEL** (bounded fan-out)
          under a shared read-lock. Any mutating filesystem op is rejected
          with `EREADONLY_VIOLATION`. Use this for independent reads
          (find / grep / cat) when you want parallel execution.

        Performance patterns:

        * For multi-pattern grep over the same file set, prefer a single
          `sb.exec("grep -E 'pat1|pat2|pat3' ...")` over batching separate
          greps — one filesystem traversal beats N. See the SDK README for
          benchmark numbers.
        * For many cheap independent scripts (echo / stat / small cat),
          `exec_batch` with up to 50 scripts has flat ~42ms overhead and is
          the fastest path.
        * The sandbox container is typically single-core; bash `& + wait`
          parallelism degrades past ~2 jobs on CPU-bound work.

        Atomicity caveat (write batches): the same read-modify-write rule as
        `exec` applies. If your batch reads state in script 1 and writes in
        script 50, that is safe (same lock). If you need Python computation
        between a read and a write, that logic must live inside a single
        script string.

        Retry semantics: identical to `exec()`. `read_only=True` batches are
        retried on transient 5xx automatically. Write batches retry only when
        `retry_on_5xx=True` is set — and only when EVERY script in the batch
        is safe to re-run from the start (the whole batch is replayed; there
        is no partial retry).
        """
        body: Dict[str, Any] = {
            "scripts": [dict(s) for s in scripts],
            "timeoutMs": timeout_ms,
        }
        if per_script_timeout_ms is not None:
            body["perScriptTimeoutMs"] = per_script_timeout_ms
        if read_only:
            body["readOnly"] = True
        if retry_on_5xx:
            body["retryOn5xx"] = True
        client_timeout = max(timeout_ms / 1000.0 + 5.0, 35.0)
        resp = self._t.request(
            "POST",
            f"/sandboxes/{self._id}/exec-sync-batch",
            json_body=body,
            timeout=client_timeout,
            idempotent=read_only or retry_on_5xx,
            read_only=read_only,
        )
        payload = resp.json()
        items = payload.get("results", []) if isinstance(payload, dict) else []
        return [BatchExecResult.from_api(item) for item in items]

    def exec_stream(
        self,
        script: str,
        *,
        cwd: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        timeout_ms: int = 30_000,
        debug: bool = False,
        read_only: bool = False,
    ) -> Iterator[StreamEvent]:
        """`POST /exec` — stream stdout/stderr/exit events as `StreamEvent`s.

        Yields events until the server emits an `exit` event. The connection is
        closed on iterator exhaustion or generator close().
        """
        body: Dict[str, Any] = {"script": script, "timeoutMs": timeout_ms}
        if cwd is not None:
            body["cwd"] = cwd
        if env is not None:
            body["env"] = dict(env)
        if debug:
            body["debug"] = True
        if read_only:
            body["readOnly"] = True

        client_timeout = max(timeout_ms / 1000.0 + 5.0, 35.0)
        resp = self._t.stream(
            "POST",
            f"/sandboxes/{self._id}/exec",
            json_body=body,
            headers={"Accept": "text/event-stream"},
            timeout=client_timeout,
        )
        try:
            for event_name, payload in iter_sse_events(resp):
                if event_name == "error":
                    msg = (
                        payload.get("error", "unknown error")
                        if isinstance(payload, dict)
                        else str(payload)
                    )
                    code = payload.get("code") if isinstance(payload, dict) else None
                    raise ValidationError(msg, code=code, status=422)
                if event_name not in ("stdout", "stderr", "exit"):
                    continue
                yield StreamEvent.from_sse(event_name, payload)
                if event_name == "exit":
                    return
        finally:
            resp.close()

    # ── ingest ──────────────────────────────────────────────────────────────
    def ingest_files(
        self,
        files: Mapping[str, Union[str, bytes]],
        *,
        base_path: str = "/home/user/project",
    ) -> Dict[str, Any]:
        """`POST /ingest-files` — write a JSON manifest of files (auto base64).

        Keys are paths relative to `base_path`. Values may be `str` (encoded
        utf-8) or `bytes` (encoded as-is); the SDK base64-encodes them.

        Each file is checked against the client's ``max_file_size`` first; an
        oversized file raises ``ValidationError`` (code ``EFILE_TOO_LARGE``)
        before anything is encoded or sent over the network.
        """
        _enforce_max_file_size(files, self._max_file_size)
        encoded: Dict[str, str] = {}
        for path, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            encoded[path] = base64.b64encode(data).decode("ascii")
        resp = self._t.request(
            "POST",
            f"/sandboxes/{self._id}/ingest-files",
            json_body={"basePath": base_path, "files": encoded},
        )
        body = resp.json()
        return body if isinstance(body, dict) else {}

    # ── lifecycle ───────────────────────────────────────────────────────────
    def delete(self) -> None:
        """`DELETE /sandboxes/{id}` — destroy this sandbox."""
        self._t.request(
            "DELETE",
            f"/sandboxes/{self._id}",
            expect_json=False,
        )
