"""Dataclass models returned by the SDK.

All models are frozen — once produced by the SDK they are immutable. Field
names follow snake_case (Python convention); the SDK translates server-side
camelCase fields when parsing responses.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, cast


@dataclass(frozen=True)
class SandboxRecord:
    """Returned by `client.sandboxes.create()` and `.list()`."""

    id: str
    name: Optional[str]
    owner: str
    created_at: str
    python: bool
    javascript: bool

    @classmethod
    def from_api(cls, payload: Dict[str, Any]) -> SandboxRecord:
        return cls(
            id=payload["id"],
            name=payload.get("name"),
            owner=payload["owner"],
            created_at=payload["createdAt"],
            python=bool(payload.get("python", False)),
            javascript=bool(payload.get("javascript", False)),
        )


@dataclass(frozen=True)
class SandboxInfo:
    """Returned by `client.sandboxes.get()`."""

    id: str
    name: Optional[str]
    owner: str
    created_at: str
    last_used_at: str

    @classmethod
    def from_api(cls, payload: Dict[str, Any]) -> SandboxInfo:
        return cls(
            id=payload["id"],
            name=payload.get("name"),
            owner=payload["owner"],
            created_at=payload["createdAt"],
            last_used_at=payload["lastUsedAt"],
        )


@dataclass(frozen=True)
class TreeEntry:
    path: str
    kind: Literal["file", "dir", "symlink"]
    size: int
    mtime: str

    @classmethod
    def from_api(cls, payload: Dict[str, Any]) -> TreeEntry:
        return cls(
            path=payload["path"],
            kind=payload["kind"],
            size=int(payload["size"]),
            mtime=payload["mtime"],
        )


@dataclass(frozen=True)
class ExecResult:
    """Result of `sandbox.exec()` / `exec_sync`."""

    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool
    duration_ms: int
    exit_signal: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.exit_code == 0

    @property
    def error(self) -> str:
        """Alias for `stderr` — matches the ergonomic shape from issue #29."""
        return self.stderr

    @classmethod
    def from_api(cls, payload: Dict[str, Any]) -> ExecResult:
        return cls(
            stdout=payload.get("stdout", ""),
            stderr=payload.get("stderr", ""),
            exit_code=int(payload["exitCode"]),
            exit_signal=payload.get("exitSignal"),
            timed_out=bool(payload.get("timedOut", False)),
            duration_ms=int(payload.get("durationMs", 0)),
        )


@dataclass(frozen=True)
class BatchExecResult:
    """One entry in the `results` array of `sandbox.exec_batch()`."""

    id: str
    stdout: str
    stderr: str
    exit_code: int
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.exit_code == 0

    @classmethod
    def from_api(cls, payload: Dict[str, Any]) -> BatchExecResult:
        return cls(
            id=payload["id"],
            stdout=payload.get("stdout", ""),
            stderr=payload.get("stderr", ""),
            exit_code=int(payload["exitCode"]),
            error=payload.get("error"),
        )


@dataclass(frozen=True)
class StreamEvent:
    """Yielded by `sandbox.exec_stream()` for each SSE event.

    `type` is one of:
      - "stdout" / "stderr": `data` holds the chunk
      - "exit": `exit_code` and `duration_ms` are set; `error` may be set
    """

    type: Literal["stdout", "stderr", "exit"]
    data: Optional[str] = None
    t: Optional[float] = None
    exit_code: Optional[int] = None
    duration_ms: Optional[int] = None
    error: Optional[str] = None

    @classmethod
    def from_sse(cls, event_name: str, payload: Dict[str, Any]) -> StreamEvent:
        if event_name == "exit":
            return cls(
                type="exit",
                t=payload.get("t"),
                exit_code=payload.get("exitCode"),
                duration_ms=payload.get("durationMs"),
                error=payload.get("error"),
            )
        if event_name in ("stdout", "stderr"):
            return cls(
                type=cast(Literal["stdout", "stderr"], event_name),
                data=payload.get("data", ""),
                t=payload.get("t"),
            )
        raise ValueError(f"unknown SSE event: {event_name!r}")


@dataclass(frozen=True)
class FileStat:
    """Parsed `X-FS-Stat` response header from `GET /files/{path}`."""

    kind: Literal["file", "dir", "symlink"]
    mode: int
    size: int
    mtime: str

    @classmethod
    def from_api(cls, payload: Dict[str, Any]) -> FileStat:
        return cls(
            kind=payload["kind"],
            mode=int(payload["mode"]),
            size=int(payload["size"]),
            mtime=payload["mtime"],
        )


# `ReadResult` bundles file bytes with the parsed `X-FS-Stat` header so callers
# can decide whether to decode as text without doing a separate `tree()` call.
@dataclass(frozen=True)
class ReadResult:
    content: bytes
    stat: Optional[FileStat] = None

    def text(self, encoding: str = "utf-8") -> str:
        return self.content.decode(encoding)


__all__ = [
    "BatchExecResult",
    "ExecResult",
    "FileStat",
    "ReadResult",
    "SandboxInfo",
    "SandboxRecord",
    "StreamEvent",
    "TreeEntry",
    "TreeEntryList",
]


TreeEntryList = List[TreeEntry]
