# Security notes

This checkout contains experimental `pip` and `databricks` support for SQL-FS
sandboxes. The feature is intended for controlled testing. It is not a general
purpose package manager or a replacement for a credential broker.

## Credential flow

The sandbox cannot read the host's `~/.databrickscfg`, host filesystem, host
Python, or host `databricks` executable. A caller that wants to run the
Databricks CLI supplies credentials for that execution through the `env` field
of the exec request:

```json
{
  "script": "databricks workspace list /",
  "env": {
    "DATABRICKS_HOST": "https://workspace.example",
    "DATABRICKS_TOKEN": "<supplied at runtime>"
  }
}
```

The request path is:

1. The API validates the request and passes `env` to just-bash as per-execution
   environment state.
2. The `databricks` custom command copies the command environment into the
   WASM Python invocation.
3. The installed Python `databricks-cli` package reads `DATABRICKS_HOST` and
   `DATABRICKS_TOKEN` using its normal environment-based authentication.
4. The SQL-FS Python compatibility layer sends supported HTTP calls through
   just-bash's `ctx.fetch` bridge.

The token is not put in the command line, written to the sandbox filesystem, or
stored in the installed package directory. The custom command redacts values of
`DATABRICKS_TOKEN`, `DATABRICKS_PASSWORD`, and `DATABRICKS_REFRESH_TOKEN` from
its returned stdout and stderr.

The token still exists in the incoming HTTP request and in API process memory
for the duration of the request. Request logging, tracing, reverse proxies, and
client-side logs must therefore exclude request bodies and these environment
variables. Do not put a token in a shell script, command string, notebook,
initial file, or URL.

The current API accepts arbitrary per-execution environment variables. That is
convenient for this experiment, but it means the API caller must be trusted not
to expose the value. A production deployment should replace raw token transport
with a server-side credential reference or credential broker. The API should
resolve that reference, inject the secret inside the service, and apply strict
tenant and sandbox authorization checks.

If a token has been pasted into chat, a terminal transcript, a ticket, or any
other potentially retained location, revoke or rotate it. Treat it as exposed.

## Isolation rules

Custom commands must preserve these rules:

- Never invoke host `pip`, Python, a shell, Docker, or `child_process`.
- Never read the host filesystem from a sandbox command. Use `ctx.fs` for
  sandbox files and `ctx.fetch` for network access.
- Never copy credentials into source files, package files, snapshots, logs, or
  Git artifacts.
- Keep network access disabled unless the sandbox was created with
  `network: true`.
- Run Python in the just-bash WASM runtime. Do not add a socket implementation
  to the worker.
- Route supported Databricks HTTP calls through the bounded `ctx.fetch` bridge.
- Do not return credentials in command output or error messages.

The `databricks` command is registered only for Python-enabled sandboxes. It
loads the installed console entry point inside WASM Python. It does not execute
an arbitrary executable from the sandbox `PATH` and it does not call the host's
Databricks CLI.

## Package installation limits

The experimental installer accepts only compatible pure-Python wheels:

- `py3-none-any`
- `py2.py3-none-any`

It resolves package metadata from PyPI, verifies the artifact SHA-256 supplied
by PyPI, and extracts files into the persistent sandbox package directory.
The installer rejects source distributions, native/platform wheels, unsupported
URLs, unsupported install options, and malformed package metadata.

Downloads, redirects, dependency count and depth, extracted file count, total
extracted bytes, archive paths, and individual file sizes are bounded. Wheel
paths are normalized and checked before extraction. Absolute paths, `..`
segments, duplicate files, and symlinks are rejected to prevent archive path
traversal and filesystem writes outside the package directory.

Installation uses ordinary `ctx.fs` writes, so package files take part in the
existing SQL-FS transaction and publication flow. A failed install must not
publish a partial package set.

## Network behavior

The installer uses HTTPS requests to the approved PyPI hosts. It does not use
raw sockets. The Databricks compatibility transport currently supports only the
read-only HTTP methods needed by the experiment. It rejects unsupported methods
instead of falling back to sockets.

A network-disabled sandbox fails clearly when `pip` or `databricks` needs
network access. Enabling network access grants the sandbox outbound access, so
callers must treat `network: true` as a separate capability and restrict which
sandboxes may request it.

## What this feature does not protect against

This experiment does not make an untrusted caller safe to give a powerful
Databricks token. Code running in the sandbox can read environment variables
available to that execution and can make any request allowed by the transport.
Use short-lived, least-privilege credentials, restrict the Databricks identity,
and keep the workspace scope narrow.

The token redaction is output filtering, not a secret store. It does not protect
against a caller who already has access to API memory, request bodies, runtime
debugging, network infrastructure, or an intentionally permitted side channel.

## Reporting a security issue

Do not include tokens, `.databrickscfg` contents, package credentials, or other
secrets in an issue or pull request. Revoke exposed credentials first, then
report the problem with a minimal reproduction and redacted logs.
