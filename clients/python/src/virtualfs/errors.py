"""Error hierarchy for the VirtualFS SDK.

All errors raised by the SDK derive from `VirtualFSError`. HTTP responses are
mapped to specific subclasses so callers can `except NotFoundError:` etc.
"""

from __future__ import annotations

from typing import Any, Optional


class VirtualFSError(Exception):
    """Base class for all SDK errors."""

    def __init__(
        self,
        message: str,
        *,
        code: Optional[str] = None,
        status: Optional[int] = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


class AuthError(VirtualFSError):
    """401 / 403 — invalid credentials or insufficient permission."""


class NotFoundError(VirtualFSError):
    """404 — sandbox, file, or directory does not exist."""


class ConflictError(VirtualFSError):
    """409 — resource already exists, or directory is non-empty."""


class ValidationError(VirtualFSError):
    """400 — request body / query parameters failed server-side validation."""


class ExecTimeoutError(VirtualFSError):
    """408 — bash execution exceeded `timeout_ms`."""

    def __init__(
        self,
        message: str,
        *,
        duration_ms: Optional[int] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(message, **kwargs)
        self.duration_ms = duration_ms


class RateLimitError(VirtualFSError):
    """429 — rate limited. `retry_after` is in seconds (from `Retry-After`)."""

    def __init__(
        self,
        message: str,
        *,
        retry_after: Optional[int] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(message, **kwargs)
        self.retry_after = retry_after


class ServerError(VirtualFSError):
    """5xx — server-side failure (after retries exhausted)."""


class TransportError(VirtualFSError):
    """Network / connection failure (DNS, TCP, TLS, read timeout)."""
