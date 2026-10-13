"""Low-level HTTP transport.

Wraps `httpx.Client` with:
  - Bearer token auth (lazily bootstrapped from `auth_secret` if needed)
  - Retry on transient 5xx / 429 with exponential backoff
  - Mapping of HTTP status codes to typed `SQLFSError` subclasses

Higher layers (Client, Sandbox, FilesAPI) should never touch httpx directly —
they always go through `Transport.request()` / `.stream()`.
"""

from __future__ import annotations

import json
import random
import re
import time
from collections.abc import Iterator, Mapping
from types import MappingProxyType
from typing import Any, Dict, List, NoReturn, Optional, Union
from urllib.parse import quote

import httpx

from ._version import __version__
from .errors import (
    AuthError,
    ConflictError,
    ExecTimeoutError,
    NotFoundError,
    RateLimitError,
    ServerError,
    SQLFSError,
    TransportError,
    ValidationError,
)

# Default retry policy. Idempotent + transient-failure paths only.
DEFAULT_MAX_RETRIES = 3
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
DEFAULT_TIMEOUT_S = 30.0
UNKNOWN_OUTCOME_CODES = frozenset({"EEXEC_OUTCOME_UNKNOWN", "EDRIVERFAULT"})
COMMITTED_WRITE_CODES = frozenset({"ECOHERENCE", "ELOCKLOST_APPLIED"})
CONNECTION_EXCEPTION_SQLSTATE = re.compile(r"08[0-9A-Z]{3}")
STREAM_ERROR_STATUS_BY_CODE: Mapping[str, int] = MappingProxyType(
    {
        "ENOENT": 404,
        "EEXIST": 409,
        "ENOTEMPTY": 409,
        "ESTALE": 409,
        "EPERM": 403,
        "FORBIDDEN": 403,
        "EISDIR": 400,
        "ENOTDIR": 400,
        "ELOOP": 400,
        "EINVAL": 400,
        "EREADONLY": 500,
        "ESESSIONCLOSING": 503,
        "ESHUTTINGDOWN": 503,
        "ELOCKTIMEOUT": 503,
        "ELOCKLOST": 503,
        "ELOCKLOST_APPLIED": 503,
        "ECOHERENCE": 503,
        "EDRIVERFAULT": 503,
        "ECOHERENCE_UNAPPLIED": 503,
        "EWORKER_BUSY": 503,
        "EWORKER_UNAVAILABLE": 503,
        "EEXEC_OUTCOME_UNKNOWN": 503,
        "ERUNTIME_BUSY": 503,
        "EUNAVAILABLE": 503,
        "ESCRIPTBUFFER": 413,
        "EEXEC_INPUT_LIMIT": 413,
        "EFBIG": 413,
        "EREADONLY_VIOLATION": 422,
        "INTERNAL_ERROR": 500,
    }
)


JsonType = Union[Dict[str, Any], List[Any], str, int, float, bool, None]


def encode_path(path: str) -> str:
    """Encode a sandbox-relative path for use in `/files/{path}`.

    The server expects no leading slash and treats `/` as a separator, so we
    only quote characters that would break URL parsing — slashes are safe.
    """
    return quote(path.lstrip("/"), safe="/")


class Transport:
    """Shared HTTP plumbing for `Client` and `Sandbox`."""

    def __init__(
        self,
        *,
        base_url: str,
        token: Optional[str] = None,
        auth_secret: Optional[str] = None,
        admin_secret: Optional[str] = None,
        sub: Optional[str] = None,
        tenant: Optional[str] = None,
        expires_in: str = "30d",
        timeout: float = DEFAULT_TIMEOUT_S,
        max_retries: int = DEFAULT_MAX_RETRIES,
        user_agent: Optional[str] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        if not (token or auth_secret or admin_secret):
            raise ValueError("Provide one of: token=..., auth_secret=..., or admin_secret=...")
        if (auth_secret or admin_secret) and not sub:
            raise ValueError("`sub` is required when bootstrapping a token from a secret")

        self._base_url = base_url.rstrip("/")
        self._token = token
        self._auth_secret = auth_secret
        self._admin_secret = admin_secret
        self._sub = sub
        self._tenant = tenant
        self._expires_in = expires_in
        self._max_retries = max_retries
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)
        self._user_agent = user_agent or f"sql-fs-sdk/{__version__}"

    # ── lifecycle ────────────────────────────────────────────────────────────
    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> Transport:
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    # ── auth ─────────────────────────────────────────────────────────────────
    @property
    def token(self) -> str:
        if self._token is None:
            self._token = self._bootstrap_token()
        return self._token

    def _bootstrap_token(self) -> str:
        """Exchange `AUTH_SECRET` (or `ADMIN_SECRET`) for a JWT.

        Uses `POST /v1/auth/bootstrap` with `X-Auth-Secret` for the standard
        path; falls back to `POST /v1/auth/admin` with `X-Admin-Secret` when
        only `admin_secret` is provided.
        """
        body: Dict[str, Any] = {"sub": self._sub, "expiresIn": self._expires_in}

        if self._auth_secret is not None:
            if self._tenant:
                body["tenant"] = self._tenant
            url = f"{self._base_url}/v1/auth/bootstrap"
            headers = {"X-Auth-Secret": self._auth_secret}
        else:
            assert self._admin_secret is not None
            url = f"{self._base_url}/v1/auth/admin"
            headers = {"X-Admin-Secret": self._admin_secret}

        resp = self._http.post(
            url,
            json=body,
            headers={**headers, "User-Agent": self._user_agent},
        )
        if resp.status_code != 201:
            self._raise_for_status(resp)
        data = resp.json()
        token = data.get("token")
        if not isinstance(token, str):
            raise AuthError(
                "bootstrap response missing token", status=resp.status_code, details=data
            )
        return token

    def _auth_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "User-Agent": self._user_agent,
        }

    # ── request execution ────────────────────────────────────────────────────
    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[JsonType] = None,
        content: Optional[bytes] = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        files: Optional[Mapping[str, Any]] = None,
        timeout: Optional[float] = None,
        expect_json: bool = True,
        idempotent: bool = True,
        read_only: bool = False,
        retry_transport_errors: bool = True,
        require_explicit_retryable: bool = False,
    ) -> httpx.Response:
        url = f"{self._base_url}/v1{path}"
        merged_headers: Dict[str, str] = self._auth_headers()
        if headers:
            merged_headers.update(headers)

        last_exc: Optional[Exception] = None
        for attempt in range(self._max_retries + 1):
            try:
                resp = self._http.request(
                    method,
                    url,
                    json=json_body if content is None else None,
                    content=content,
                    params=params,
                    headers=merged_headers,
                    files=files,
                    timeout=timeout,
                )
            except httpx.TransportError as e:
                last_exc = e
                if (
                    not retry_transport_errors
                    or attempt >= self._max_retries
                    or (not idempotent and not read_only)
                ):
                    raise TransportError(f"network error after {attempt + 1} attempts: {e}") from e
                self._sleep_backoff(attempt)
                continue

            if (
                resp.status_code in RETRY_STATUS
                and attempt < self._max_retries
                and _should_retry_response(
                    resp,
                    idempotent=idempotent,
                    read_only=read_only,
                    method=method,
                    require_explicit_retryable=require_explicit_retryable,
                )
            ):
                # Honour Retry-After when present, else exponential jitter.
                retry_after = _parse_retry_after(resp)
                if retry_after is not None:
                    time.sleep(min(retry_after, 30))
                else:
                    self._sleep_backoff(attempt)
                continue

            if resp.status_code >= 400:
                self._raise_for_status(resp)
            return resp

        # Unreachable — loop either returns or raises.
        raise TransportError(f"unexpected retry exhaustion: {last_exc}")

    def stream(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[JsonType] = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> httpx.Response:
        """Open a streaming response (used for SSE exec and tar.gz export).

        The caller is responsible for `.close()` on the response when done.
        Streaming responses are NOT retried — at-most-once semantics.
        """
        url = f"{self._base_url}/v1{path}"
        merged_headers = self._auth_headers()
        if headers:
            merged_headers.update(headers)

        req = self._http.build_request(
            method,
            url,
            json=json_body,
            params=params,
            headers=merged_headers,
            timeout=timeout,
        )
        resp = self._http.send(req, stream=True)
        if resp.status_code >= 400:
            # Body must be drained before mapping the error; tiny payloads.
            try:
                resp.read()
            finally:
                resp.close()
            self._raise_for_status(resp)
        return resp

    # ── error mapping ────────────────────────────────────────────────────────
    def _raise_for_status(self, resp: httpx.Response) -> None:
        _raise_api_error(resp.status_code, _parse_error_body(resp), _parse_retry_after(resp))

    # ── retry sleep ──────────────────────────────────────────────────────────
    def _sleep_backoff(self, attempt: int) -> None:
        # Exponential backoff with full jitter: [0, base * 2^attempt)
        base = 0.25
        delay = random.uniform(0, base * (2**attempt))
        time.sleep(min(delay, 8.0))


# ── module-level helpers ─────────────────────────────────────────────────────
def _status_for_stream_error(code: str) -> int:
    return STREAM_ERROR_STATUS_BY_CODE.get(code, 422)


def _raise_api_error(
    status: int,
    body: Mapping[str, Any],
    retry_after: Optional[int] = None,
) -> NoReturn:
    message = body.get("error")
    message = message if isinstance(message, str) else f"HTTP {status}"
    raw_code = body.get("code")
    code = raw_code if isinstance(raw_code, str) else None
    raw_retryable = body.get("retryable")
    retryable = raw_retryable if isinstance(raw_retryable, bool) else None
    details = body.get("details")
    if status == 408:
        raise ExecTimeoutError(
            message,
            code=code,
            status=status,
            details=details,
            retryable=retryable,
            duration_ms=body.get("durationMs"),
        )
    if status == 429:
        raise RateLimitError(
            message,
            code=code,
            status=status,
            details=details,
            retryable=retryable,
            retry_after=retry_after,
        )
    error_type: type[SQLFSError]
    if status in (401, 403):
        error_type = AuthError
    elif status == 404:
        error_type = NotFoundError
    elif status == 409:
        error_type = ConflictError
    elif status in (400, 413, 422):
        error_type = ValidationError
    elif 500 <= status < 600:
        error_type = ServerError
    else:
        error_type = SQLFSError
    raise error_type(message, code=code, status=status, details=details, retryable=retryable)


def _parse_error_body(resp: httpx.Response) -> Dict[str, Any]:
    """Best-effort parse of `{ error, code, details }` JSON response body."""
    try:
        body = resp.json()
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    return body


def _should_retry_response(
    resp: httpx.Response,
    *,
    idempotent: bool,
    read_only: bool,
    method: str,
    require_explicit_retryable: bool,
) -> bool:
    body = _parse_error_body(resp)
    raw_code = body.get("code")
    code = raw_code if isinstance(raw_code, str) else None
    if code == "EEXEC_OUTCOME_UNKNOWN":
        return False
    if code in COMMITTED_WRITE_CODES:
        return False
    if require_explicit_retryable and body.get("retryable") is not True:
        return False
    safe_read = idempotent and method in ("GET", "HEAD")
    if (
        safe_read
        and resp.status_code == 503
        and (
            code in ("EDRIVERFAULT", "EUNAVAILABLE")
            or (code is not None and CONNECTION_EXCEPTION_SQLSTATE.fullmatch(code) is not None)
        )
    ):
        return True
    if code in UNKNOWN_OUTCOME_CODES or (
        code is not None and CONNECTION_EXCEPTION_SQLSTATE.fullmatch(code) is not None
    ):
        return False
    return body.get("retryable") is not False and (idempotent or read_only)


def _parse_retry_after(resp: httpx.Response) -> Optional[int]:
    raw = resp.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def iter_sse_events(resp: httpx.Response) -> Iterator[tuple[str, Any]]:
    """Iterate SSE events from a streaming response.

    Yields `(event_name, parsed_json)` tuples. `data:` lines are concatenated
    per event and parsed as JSON. Comment lines (`:`) are skipped.
    """
    event = "message"
    data_lines: List[str] = []
    for line in resp.iter_lines():
        if line == "":
            if data_lines:
                raw = "\n".join(data_lines)
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = {"raw": raw}
                yield event, payload
            event = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:") :].lstrip(" "))
    # Trailing event without blank line
    if data_lines:
        raw = "\n".join(data_lines)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        yield event, payload
