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

## Package installation

The experimental installer accepts only compatible pure-Python wheels:

- `py3-none-any`
- `py2.py3-none-any`

It resolves package metadata from PyPI, verifies the artifact SHA-256 supplied
by PyPI, and refuses source distributions, native/platform wheels, unsupported
URLs, unsupported install options, and malformed package metadata.

### Extraction happens on the host, not in the sandbox

A wheel is never handed to sandbox code. `src/api/commands/wheel-reader.ts`
opens it with `yauzl` in the API process and validates the whole central
directory *before* the first byte is inflated: the encryption flag, compression
methods other than store/deflate, data descriptors with unknown sizes, symlinks
declared through external attributes, directory-versus-file collisions,
duplicate paths, and any path that is absolute, carries a drive letter, a NUL, a
backslash, a `.`/`..`/empty segment, or exceeds 512 characters. yauzl does not
compare a local file header against the central directory, so the reader does
that itself — filename bytes, compression method, CRC and both sizes, with the
ZIP64 extra field resolved on the local side.

Every entry is then inflated through `zlib.createInflateRaw` with
`maxOutputLength` set to its declared size, plus an independent byte counter, so
a zip bomb is refused at the declared size rather than after it has been
materialised. Inflation is asynchronous and batched (at most 8 MB inflated or
500 entries in flight) for two reasons: the host never holds a whole extracted
package in memory, and it never blocks the event loop that renews the Redis
leases. Each entry's CRC-32 is checked against the archive and its SHA-256
against the wheel's `RECORD`; a `RECORD` that does not list every non-`RECORD`
entry, or a `WHEEL` that is not `Wheel-Version: 1.x` / `Root-Is-Purelib: true`,
fails the install. Any zlib or stream failure becomes one "corrupt or hostile
archive" error, and a fuzz suite asserts that no third-party error escapes the
reader.

Extracted bytes are committed as content-addressed blobs and recorded in a
tenant-global `package_manifests` row; the sandbox tree is changed in one
DB-only graft step at the end. A failed install therefore publishes nothing —
blobs and manifests are shared, reusable state, not a partially installed
package.

### Limits

Every limit is read once from the environment in
`src/api/commands/package-limits.ts`, and every refusal names both the number
and its knob.

| Limit | Default | Env |
|---|---|---|
| Largest single wheel | 32 MB | `PIP_MAX_WHEEL_BYTES` |
| Downloaded bytes per install | 256 MB | `PIP_MAX_INSTALL_DOWNLOAD_BYTES` |
| Largest single extracted file | 32 MB | `PIP_MAX_FILE_BYTES` |
| Extracted bytes per install | 512 MB | `PIP_MAX_INSTALL_BYTES` |
| Extracted files per install | 50 000 | `PIP_MAX_INSTALL_FILES` |
| Package bytes per sandbox | 1 GB | `PIP_SANDBOX_QUOTA_BYTES` |
| Package files per sandbox | 100 000 | `PIP_SANDBOX_MAX_FILES` |
| Concurrent installs per replica | 2 | `MAX_CONCURRENT_PIP_INSTALLS` |
| Metadata bytes / requests / cache entries per install | 32 MB / 200 / 200 | `PIP_MAX_METADATA_BYTES`, `PIP_MAX_METADATA_REQUESTS`, `PIP_MAX_METADATA_CACHE_ENTRIES` |
| Single PyPI JSON response | 16 MB | `PIP_MAX_METADATA_RESPONSE_BYTES` |
| Dependency depth | 16 | `PIP_MAX_DEPENDENCY_DEPTH` |

The two per-sandbox quotas are computed in the publish step from the manifests
the sandbox's `sandbox_packages` rows reference, before anything is written.
Files sitting under `/site-packages` from an install that predates the ledger
have no rows, so they are **outside the quota** until that package is installed
again; the first install after the upgrade writes ledger rows only for what it
installs.

### Known just-bash runtime limits

These are limits of the sandbox runtime, not of the installer, and they are
noted rather than fixed here:

- The CPython worker's SharedArrayBuffer bridge has an 8 MB data buffer, so a
  sandbox **file read or write above 8 MB fails inside Python** regardless of
  what the filesystem can store. Host-side extraction means a wheel may now
  exceed 8 MB, but an individual file a script reads back still may not.
- The same region bounds `jb_http` responses, which are base64-encoded across
  it: the practical response ceiling is roughly **6 MB**.

An upstream just-bash change to the bridge would lift both. Until it ships,
size any package workflow accordingly.

### Deferred upstream change

`src/api/commands/pypi-fetch.ts` exists because just-bash's `createSecureFetch`
is not reachable through the package's exports map. It is a GET-only wrapper
pinned to `pypi.org` and `files.pythonhosted.org`, with `redirect: "manual"`,
a `content-length` pre-check, a streaming byte counter and a composed abort
signal — no DNS or private-range check is needed because the hostnames are
fixed. An upstream PR to export `createSecureFetch` has **not** been opened;
when it lands, this wrapper should be deleted rather than maintained.

## Network behavior

The installer uses HTTPS requests to the approved PyPI hosts. It does not use
raw sockets. A network-disabled sandbox fails clearly when `pip` or
`databricks` needs network access.

`network: true` is the real capability boundary. A sandbox created with it
runs its `Bash` with `dangerouslyAllowFullInternetAccess`, which enables every
HTTP method — `git push` over HTTPS needs POST, so the transport cannot be
restricted to read-only methods without breaking git. There is therefore no
transport-level enforcement of read-only access, and none is claimed here.

`networkWrite` is a second, per-sandbox flag, default off, rejected at create
time unless `network` is also true. When it is set, the session exports
`SQLFS_HTTP_WRITE=1` into the sandbox shell and the Python `requests`
compatibility shim permits POST, PUT, PATCH and DELETE; without it the shim
raises `requests.exceptions.NetworkWriteNotPermitted` and only GET and HEAD go
out. That is a guardrail against an installed package writing to a Databricks
workspace by accident — it is not a sandbox boundary. `jb_http`, `curl` and
`git` are not restricted by it, and sandbox code can call them directly.

Treat `network: true` as the capability to grant sparingly and restrict which
callers may request it; treat `networkWrite` as an additional opt-in for
workflows that genuinely need to write.

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
