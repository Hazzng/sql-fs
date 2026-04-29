"""Python SDK for the VirtualFS API.

Quick start:

    from virtualfs import Client

    with Client(base_url="https://...", auth_secret="...", sub="my-agent") as c:
        sb = c.sandboxes.create(name="demo", python=True)
        result = sb.exec("echo hello")
        print(result.stdout, result.exit_code)
        sb.delete()
"""

from ._version import __version__
from .client import Client, SandboxesResource
from .errors import (
    AuthError,
    ConflictError,
    ExecTimeoutError,
    NotFoundError,
    RateLimitError,
    ServerError,
    TransportError,
    ValidationError,
    VirtualFSError,
)
from .models import (
    BatchExecResult,
    ExecResult,
    FileStat,
    ReadResult,
    SandboxInfo,
    SandboxRecord,
    StreamEvent,
    TreeEntry,
)
from .sandbox import FilesAPI, Sandbox

__all__ = [
    "AuthError",
    "BatchExecResult",
    "Client",
    "ConflictError",
    "ExecResult",
    "ExecTimeoutError",
    "FileStat",
    "FilesAPI",
    "NotFoundError",
    "RateLimitError",
    "ReadResult",
    "Sandbox",
    "SandboxInfo",
    "SandboxRecord",
    "SandboxesResource",
    "ServerError",
    "StreamEvent",
    "TransportError",
    "TreeEntry",
    "ValidationError",
    "VirtualFSError",
    "__version__",
]
