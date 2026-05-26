"""Top-level `Client` for the SQL-FS API."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Dict, List, Optional

import httpx

from ._http import Transport
from .models import SandboxInfo, SandboxRecord
from .sandbox import Sandbox


class Client:
    """Entry point for the SQL-FS API.

    Construct with either a pre-issued `token` or a server `auth_secret`
    (the SDK will exchange it for a JWT on first use):

        client = Client(base_url="https://...", token="eyJ...")

        client = Client(
            base_url="https://...",
            auth_secret="my-secret",
            sub="my-agent",
        )

    The client is safe to keep around for the lifetime of your process. Use
    `with Client(...) as c:` to ensure HTTP connections are released.
    """

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
        timeout: float = 30.0,
        max_retries: int = 3,
        user_agent: Optional[str] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self._transport = Transport(
            base_url=base_url,
            token=token,
            auth_secret=auth_secret,
            admin_secret=admin_secret,
            sub=sub,
            tenant=tenant,
            expires_in=expires_in,
            timeout=timeout,
            max_retries=max_retries,
            user_agent=user_agent,
            http_client=http_client,
        )
        self.sandboxes = SandboxesResource(self._transport)

    @property
    def token(self) -> str:
        """The current JWT (lazily bootstrapped from `auth_secret` if needed)."""
        return self._transport.token

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()


class SandboxesResource:
    """`client.sandboxes.*` — sandbox CRUD."""

    def __init__(self, transport: Transport) -> None:
        self._t = transport

    def list(self) -> List[SandboxRecord]:
        """`GET /v1/sandboxes` — list sandboxes owned by the caller."""
        resp = self._t.request("GET", "/sandboxes")
        body = resp.json()
        items = body.get("sandboxes", []) if isinstance(body, dict) else []
        return [SandboxRecord.from_api(item) for item in items]

    def create(
        self,
        *,
        name: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        files: Optional[Mapping[str, str]] = None,
        python: bool = False,
        javascript: bool = False,
        network: bool = False,
    ) -> Sandbox:
        """`POST /v1/sandboxes` — create a new sandbox.

        Args:
            name: Optional human-readable label for the sandbox.
            env: Environment variables exposed to processes inside the sandbox.
            files: Initial files to seed the sandbox filesystem with, keyed by path.
            python: Enable the CPython WASM runtime.
            javascript: Enable the QuickJS / `js-exec` runtime.
            network: Opt-in to outbound network access. When enabled, `fetch()`
                inside `js-exec` can reach external HTTP endpoints (timeout
                extends to 60 s). Bash itself remains air-gapped — no `curl`,
                `wget`, DNS, or raw sockets — so `fetch()` is the only egress
                path. Defaults to `False` (secure-by-default). Requires
                `javascript=True` to have any effect.

        Returns a bound `Sandbox` handle ready for exec / file operations.
        """
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if env is not None:
            body["env"] = dict(env)
        if files is not None:
            body["files"] = dict(files)
        if python:
            body["python"] = True
        if javascript:
            body["javascript"] = True
        if network:
            body["network"] = True

        resp = self._t.request("POST", "/sandboxes", json_body=body or None)
        record = SandboxRecord.from_api(resp.json())
        return Sandbox(self._t, record.id, record=record)

    def get(self, sandbox_id: str) -> SandboxInfo:
        """`GET /v1/sandboxes/{id}` — fetch sandbox metadata."""
        resp = self._t.request("GET", f"/sandboxes/{sandbox_id}")
        return SandboxInfo.from_api(resp.json())

    def attach(self, sandbox_id: str) -> Sandbox:
        """Return a `Sandbox` handle for an existing sandbox.

        Does not hit the network — use `.get(id)` first if you want to verify
        the sandbox exists / is accessible to the current token.
        """
        return Sandbox(self._t, sandbox_id)

    def delete(self, sandbox_id: str) -> None:
        """`DELETE /v1/sandboxes/{id}` — destroy the sandbox and all blobs."""
        self._t.request("DELETE", f"/sandboxes/{sandbox_id}", expect_json=False)
