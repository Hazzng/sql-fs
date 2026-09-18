---
date: 2026-09-18T13:10:00+09:30
researcher: Harry.Nguyen@insightfactory.ai
target_repo: just-bash (upstream), fork at github.com/Hazzng/just-bash
target_version: 3.4.2 (monorepo main at a25da1d, packages/just-bash)
verified_against: packages/just-bash/src/commands/worker-bridge/*.ts, src/commands/python3/worker.ts, src/commands/python3/python3.ts
repository: virtualFS (consumer)
task: "Upstream PR design: streamed file I/O and out-of-band HTTP bodies for the worker bridge"
tags: [just-bash, upstream-pr, worker-bridge, sharedarraybuffer, python3, js-exec, jb_http, memory]
status: draft
---

# just-bash PR: stream large files and HTTP bodies through the worker bridge

## One-paragraph summary for the PR description

The SharedArrayBuffer bridge between the main thread and the `python3` /
`js-exec` workers moves every file and every HTTP response through a single
fixed 8 MB data region. Any file read, file write, or HTTP body above that size
throws `Data too large` / `Result too large` deep inside the worker, surfacing to
the user as an opaque I/O error. This PR keeps the buffer size and the existing
opcodes unchanged, and adds three additive operations: a ranged file read, a
chunked file write that the host assembles into one atomic `writeFile`, and a
body handle for HTTP responses that the worker reads in ranges instead of
receiving as a base64 string inside a JSON result. The Emscripten HOSTFS layer
in the Python worker and the `fs`/`fetch` shims in the QuickJS worker are
switched to the new operations. Files and responses are then bounded only by the
configurable `maxFileSize` and `maxResponseSize` limits, not by the transport.
As a side effect, HOSTFS `rename` stops copying file contents through the bridge
and uses the existing `RENAME` op.

## Background: how the bridge works today

All references are to `packages/just-bash/src/` at 3.4.2.

### Layout (`commands/worker-bridge/protocol.ts:82-104`)

```
Offset  Field           Size
0       OP_CODE         i32
4       STATUS          i32   PENDING | READY | SUCCESS | ERROR
8       PATH_LENGTH     i32
12      DATA_LENGTH     i32
16      RESULT_LENGTH   i32
20      ERROR_CODE      i32
24      FLAGS           i32
28      MODE            i32
32      PATH_BUFFER     4096 bytes
4128    DATA_BUFFER     8 388 608 bytes   (request data in, result out, same region)
TOTAL   8 392 736
```

The control region is exactly full: eight 4-byte slots. Request payload and
result share `DATA_BUFFER`. `setData` and `setResult` throw when the payload
exceeds `Size.DATA_BUFFER` (`protocol.ts:241-247`, `:267-273`).

### The synchronous round trip

Worker side (`sync-backend.ts:28-63`): `execSync` resets the buffer, writes
opcode, path, flags, mode and optional data, sets `STATUS=READY`, notifies, then
`Atomics.wait`s for the status to leave `READY`. Host side
(`bridge-handler.ts:107-139`): `run()` loops on `waitUntilReady`, dispatches on
opcode, writes the result, sets `SUCCESS` or `ERROR`, notifies. One operation
in flight at a time, by construction.

### Whole-file semantics

- `READ_FILE` → `fs.readFileBuffer(path)` → `setResult(content)`
  (`bridge-handler.ts:227-236`). Whole file, one op, capped at 8 MB.
- `WRITE_FILE` → `fs.writeFile(path, getData())` (`:238-247`). Whole file, one
  op, capped at 8 MB.
- `APPEND_FILE` exists (`:318-327`) but no consumer uses it.

### How the Python worker uses it (`commands/python3/worker.ts`)

`createHOSTFS` (`:308`) implements an Emscripten filesystem mounted at `/host`
(`:1397`). The relevant behaviours:

| Emscripten event | HOSTFS behaviour | Bridge ops |
|---|---|---|
| `open(path, "rb")`, `"r+"`, `"a"` | `content = backend.readFile(path)` into `stream.hostContent` (`:553`); throws `EFBIG` if larger than `maxFileSize` (`:563`) | 1 × `READ_FILE`, whole file |
| `open(path, "wb")` | `content = new Uint8Array(0)` (`:550`) | none |
| `read()` | served from `stream.hostContent` (`:588-604`) | none |
| `write()` | grows `stream.hostContent` in worker memory (`:606-637`) | none |
| `close()` | `backend.writeFile(hostPath, hostContent)` if modified (`:576-584`) | 1 × `WRITE_FILE`, whole file |
| `mknod` (file create) | `backend.writeFile(path, new Uint8Array(0))` (`:484`) | 1 × `WRITE_FILE` |
| `rename` | `readFile` + `writeFile` + `rm` (`:494-496`) | 3 ops, whole file twice |
| `setattr` with `size` (truncate) | `readFile` + `writeFile` (`:463-466`) | 2 ops, whole file |

`maxFileSize` comes from `WorkerInput.maxFileSize` (`worker.ts:38`), set by
`python3.ts:520` to `ctx.limits.maxStringLength` (default 10 MB), with an 8 MB
fallback at `worker.ts:1393`. So today the *configured* file limit is 10 MB but
the *transport* limit is 8 MB, and the transport wins with a worse error.

### HTTP (`createHTTPFS`, `worker.ts:1005-1160`; `handleHttpRequest`, `bridge-handler.ts:500-548`)

Python writes request JSON to `/_jb_http/request`; `close` calls
`backend.httpRequest` (`worker.ts:1087`). The host runs `secureFetch`, then
builds `JSON.stringify({ status, statusText, headers, bodyBase64, url })` and
`setResultFromString`s it (`bridge-handler.ts:531-538`). The worker `atob`s
the body (`sync-backend.ts:252-253`) and Python `b64decode`s it again
(`worker.ts:1176-1178`).

Consequences: the base64 string plus JSON overhead must fit in 8 MB, so the
effective HTTP body ceiling is about 6 MB, regardless of `maxResponseSize`
(default 10 MB, `network/types.ts`). The failure is `Result too large`, caught
by `handleOperation`'s catch, reported as `NETWORK_ERROR`, and the
`ResponseTooLargeError` path that `secureFetch` has for the real limit never
fires. There are also three copies of the body in flight (bytes, base64 string,
JSON string) on the host and two more in the worker.

### The js-exec worker

The QuickJS worker embeds its own copy of the protocol constants and
`SyncBackend` (the bundled `js-exec-worker.js` contains `DATA_BUFFER: 8388608`
and the same `Data too large` check). Its `fs.readFile`, `fs.readFileBuffer`,
`fs.writeFile` shims call `backend.readFile` / `backend.writeFile` directly,
and its `fetch` polyfill consumes `httpRequest().body`. It has the same ceilings
and must receive the same changes. Confirm during implementation how that bundle
is produced; `scripts/check-worker-sync.js` currently only covers the `python3`
and `sqlite3` workers.

## Problem statement

1. A 9 MB file that the embedder's `IFileSystem` holds without difficulty cannot
   be read or written by Python or JavaScript code in the sandbox.
2. The error the user sees (`Data too large: N > 8388608`, or `wheel extraction
   failed`, or a bare `OSError`) does not name the limit or how to raise it, and
   raising `maxStringLength` does not help because the transport is the binding
   constraint.
3. HTTP responses between roughly 6 MB and `maxResponseSize` fail in the worker
   with a transport error rather than the documented `ResponseTooLargeError`.
4. Renaming a large file copies it through the bridge twice.
5. Embedders with a persistent or remote `IFileSystem` pay the full cost of every
   byte crossing the bridge as base64 or as duplicated JSON strings.

## Goals

- File reads, file writes, and HTTP bodies in the worker are bounded by
  `maxFileSize` and `maxResponseSize` only. Raising those limits works.
- No change to the buffer size, the existing opcodes, or their semantics.
  Files at or below 8 MB take exactly the same number of round trips as today.
- One `IFileSystem.writeFile` per file written from the worker, so filesystems
  with content-addressed or transactional semantics see one atomic write.
- The host never holds more than one copy of a body or file, and never a
  base64 or JSON-string copy of binary data.
- Errors name the limit and the knob.

## Non-goals

- Streaming writes from the worker as the guest calls `write()`. The worker
  still buffers a file being written in WASM memory until `close()`. Bounded by
  `maxFileSize` as today. A follow-up could add write-through with a host-side
  staging buffer.
- Changing the request body encoding for `jb_http` (still a string). Separate
  issue.
- Making `APPEND_FILE` used by HOSTFS.
- Any browser build change. The worker bridge is Node-only.

## Design

### Protocol additions (`protocol.ts`)

Three new opcodes, additive:

```ts
export const OpCode = {
  // ...existing...
  READ_FILE_RANGE: 16,
  WRITE_FILE_CHUNK: 17,
  HTTP_READ_BODY: 201,
  HTTP_RELEASE_BODY: 202,
} as const;
```

Two new control fields for a 64-bit offset and a 32-bit length. The current
control region has no spare slots, so grow it. Everything after it shifts:

```ts
const Offset = {
  OP_CODE: 0, STATUS: 4, PATH_LENGTH: 8, DATA_LENGTH: 12, RESULT_LENGTH: 16,
  ERROR_CODE: 20, FLAGS: 24, MODE: 28,
  ARG_OFFSET: 32,   // f64, little-endian, safe integer
  ARG_LENGTH: 40,   // i32
  PATH_BUFFER: 48,
  DATA_BUFFER: 4144, // 48 + 4096
} as const;

const Size = {
  CONTROL_REGION: 48,
  PATH_BUFFER: 4096,
  DATA_BUFFER: 8388608,
  TOTAL: 8392752, // 48 + 4096 + 8MB
} as const;
```

Accessors: `getArgOffset()/setArgOffset(n)` via `DataView.getFloat64/setFloat64`
(the `dataView` already exists on `ProtocolBuffer`), and
`getArgLength()/setArgLength(n)` via `Atomics` on the int32 view. `reset()`
clears both. Add `Flags.CHUNK_FIRST = 4` and `Flags.CHUNK_LAST = 8`.

Both sides of the bridge come from the same build, so the layout change needs
no versioning. The js-exec worker's inlined copy of the constants must be
regenerated in the same change.

Alternative considered: encode offset and length in the first 12 bytes of
`DATA_BUFFER` for the read op and avoid the layout change. Rejected because
`WRITE_FILE_CHUNK` carries payload in `DATA_BUFFER` and would need the offset
elsewhere anyway; two encodings for the same concept is worse than growing the
header by 16 bytes.

### Op 16: `READ_FILE_RANGE(path, offset, length) → bytes`

Host (`bridge-handler.ts`):

```ts
private async handleReadFileRange(): Promise<void> {
  const path = this.resolvePath(this.protocol.getPath());
  const offset = this.protocol.getArgOffset();
  const length = this.protocol.getArgLength();
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > Size.DATA_BUFFER) {
    return this.setError(ErrorCode.INVALID_PATH, "invalid range");
  }
  try {
    const content = await this.readCached(path);
    const end = Math.min(content.length, offset + length);
    this.protocol.setResult(offset >= content.length ? EMPTY : content.subarray(offset, end));
    // Total size travels in ARG_OFFSET on the way back so the worker can size its stream.
    this.protocol.setArgOffset(content.length);
    this.protocol.setStatus(Status.SUCCESS);
  } catch (e) { this.setErrorFromException(e); }
}
```

`readCached` is a single-entry cache `{ path, bytes }` on the handler. A file
read in 8 MB ranges would otherwise call `fs.readFileBuffer` once per range;
with the cache it is read once. The entry is invalidated by any op that can
change that path: `WRITE_FILE`, `WRITE_FILE_CHUNK` commit, `APPEND_FILE`, `RM`,
`RENAME`, `COPY_FILE` (destination), `CHMOD` is fine to ignore. The cache holds
at most one file, so its memory cost is one file, which the host already paid
to serve the first range.

Optionally, if `IFileSystem` gains an optional `readFileRange?(path, offset,
length)` later, `readCached` can prefer it. Not required for this PR.

Worker (`sync-backend.ts`):

```ts
readFileRange(path: string, offset: number, length: number): { bytes: Uint8Array; totalSize: number } {
  const result = this.execSync(OpCode.READ_FILE_RANGE, path, undefined, 0, 0, offset, length);
  if (!result.success) throw new Error(result.error || "Failed to read file");
  return { bytes: result.result ?? new Uint8Array(0), totalSize: this.protocol.getArgOffset() };
}

/** Whole-file read for callers that need it, using ranged ops above one buffer. */
readFileAll(path: string, maxBytes: number): Uint8Array {
  const first = this.readFileRange(path, 0, Size.DATA_BUFFER);
  if (first.totalSize > maxBytes) throw new FileTooLargeError(first.totalSize, maxBytes);
  if (first.totalSize <= first.bytes.length) return first.bytes;
  const out = new Uint8Array(first.totalSize);
  out.set(first.bytes, 0);
  for (let pos = first.bytes.length; pos < first.totalSize; ) {
    const { bytes } = this.readFileRange(path, pos, Size.DATA_BUFFER);
    if (bytes.length === 0) throw new Error("file shrank during read");
    out.set(bytes, pos);
    pos += bytes.length;
  }
  return out;
}
```

`execSync` gains two optional trailing parameters `argOffset` and `argLength`.
Existing callers are unchanged. `readFile(path)` keeps its signature and becomes
`readFileAll(path, Infinity)` so the legacy op is no longer used by the
worker; `READ_FILE` stays in the protocol for compatibility.

### Op 17: `WRITE_FILE_CHUNK(path, offset, data, flags FIRST|LAST) → void`

Semantics: the worker sends the file as consecutive chunks of at most
`DATA_BUFFER` bytes. The host stages them and issues exactly one
`fs.writeFile(path, assembled)` when it sees `CHUNK_LAST`. A file that fits in
one chunk is sent with both flags set and costs one op, the same as today.

Host:

```ts
private staging: { path: string; parts: Uint8Array[]; bytes: number } | null = null;

private async handleWriteFileChunk(): Promise<void> {
  const path = this.resolvePath(this.protocol.getPath());
  const offset = this.protocol.getArgOffset();
  const flags = this.protocol.getFlags();
  const data = this.protocol.getData();
  const first = (flags & Flags.CHUNK_FIRST) !== 0;
  const last = (flags & Flags.CHUNK_LAST) !== 0;

  if (first) this.staging = { path, parts: [], bytes: 0 };
  const s = this.staging;
  if (!s || s.path !== path || offset !== s.bytes) {
    this.staging = null;
    return this.setError(ErrorCode.IO_ERROR, "write chunk out of sequence");
  }
  if (s.bytes + data.length > this.maxFileSize) {
    this.staging = null;
    return this.setError(ErrorCode.IO_ERROR, `file exceeds maxFileSize (${this.maxFileSize} bytes)`);
  }
  s.parts.push(data); // getData() already copies out of the shared buffer
  s.bytes += data.length;
  if (!last) return this.protocol.setStatus(Status.SUCCESS);

  this.staging = null;
  try {
    const assembled = s.parts.length === 1 ? s.parts[0] : concat(s.parts, s.bytes);
    await this.fs.writeFile(path, assembled);
    this.invalidateReadCache(path);
    this.protocol.setStatus(Status.SUCCESS);
  } catch (e) { this.setErrorFromException(e); }
}
```

Why stage on the host rather than `appendFile` per chunk: `appendFile` would
turn one logical write into N filesystem mutations, which breaks atomicity, is
O(n²) on filesystems that implement append as read-modify-write, and defeats
content-addressed backends. Staging costs one copy of the file on the host,
which the host would hold during `writeFile` regardless.

`stop()` and `handleExit()` discard any staging. `BridgeHandler` gains a
`maxFileSize` constructor argument (default `Infinity`) so the same limit the
worker enforces is enforced on the host too; `python3.ts` passes the value it
already computes for `WorkerInput.maxFileSize`.

Worker:

```ts
writeFileChunked(path: string, data: Uint8Array): void {
  const total = data.length;
  let pos = 0;
  do {
    const end = Math.min(total, pos + Size.DATA_BUFFER);
    const flags = (pos === 0 ? Flags.CHUNK_FIRST : 0) | (end === total ? Flags.CHUNK_LAST : 0);
    const r = this.execSync(OpCode.WRITE_FILE_CHUNK, path, data.subarray(pos, end), flags, 0, pos, 0);
    if (!r.success) throw new Error(r.error || "Failed to write file");
    pos = end;
  } while (pos < total);
}
```

`writeFile(path, data)` keeps its signature and delegates to
`writeFileChunked`, so all existing consumers (HOSTFS `close`, `mknod`, js-exec
shims) pick up the change without edits. An empty file is one chunk with both
flags and zero bytes.

### Ops 201/202: HTTP body handles

`HTTP_REQUEST` changes only what it returns. The host keeps the body bytes and
returns metadata:

```ts
const handle = this.storeBody(result.body); // 0 when body is empty
const response = JSON.stringify({
  status: result.status, statusText: result.statusText, headers: result.headers,
  url: result.url, bodyLength: result.body.length, bodyHandle: handle,
});
```

`storeBody` puts the `Uint8Array` in `Map<number, Uint8Array>` keyed by an
incrementing id. Bounds: at most 4 live handles and total live bytes at most
`maxResponseSize × 2` or 64 MB, whichever is smaller; exceeding either evicts
the oldest handle. All handles are dropped in `stop()` and `handleExit()`.
Handles are per `BridgeHandler`, so per execution.

`HTTP_READ_BODY(handle in ARG_LENGTH, offset in ARG_OFFSET, length in MODE)`
returns a range of the body; `HTTP_RELEASE_BODY(handle)` frees it. Path is
empty for both. Worker side:

```ts
httpRequest(url, options): { status, statusText, headers, url, body: Uint8Array } {
  const meta = JSON.parse(decode(this.execSync(OpCode.HTTP_REQUEST, url, encodeOptions(options)).result));
  const body = new Uint8Array(meta.bodyLength);
  for (let pos = 0; pos < meta.bodyLength; ) {
    const r = this.execSync(OpCode.HTTP_READ_BODY, "", undefined, 0, Size.DATA_BUFFER, pos, meta.bodyHandle);
    body.set(r.result, pos); pos += r.result.length;
  }
  if (meta.bodyHandle) this.execSync(OpCode.HTTP_RELEASE_BODY, "", undefined, 0, 0, 0, meta.bodyHandle);
  return { ...meta, body };
}
```

The return type changes from `{ body: string; bodyBase64: string }` to
`{ body: Uint8Array }`. Both consumers are inside the package, so this is an
internal API change. A body of any size below `maxResponseSize` now costs
1 + ceil(n / 8 MB) + 1 ops and zero base64 or JSON copies. For the common case
of a small JSON API response that is three ops instead of one; if that matters,
inline bodies of at most 256 KB as `bodyBase64` in the metadata and skip the
handle, keeping the decode path in the worker for that case only. Recommended,
and cheap: the worker checks `bodyBase64 !== undefined` first.

### HOSTFS changes (`python3/worker.ts`)

- `stream_ops.open` for read or read-write modes: replace `backend.readFile(path)`
  with `backend.readFileAll(path, maxFileSize)`, and map the new
  `FileTooLargeError` to `EFBIG` as the existing check does. The `EFBIG`
  message is what Python users see as `OSError: [Errno 27] File too large`,
  which is correct and searchable.
- `stream_ops.close`: `backend.writeFile` is now chunked via the delegate; no
  edit needed.
- `node_ops.rename`: replace the read, write, rm sequence with
  `backend.rename(oldPath, newPath)`, which already maps to `fs.mv` on the host
  (`bridge-handler.ts:374-383`). Fixes the double copy and the size cap on
  rename in the same PR; it is a one-line change to an op that already exists.
- `node_ops.setattr` truncate: use `readFileAll` then `writeFile`. Unchanged
  shape, no longer capped by the transport.
- Optional, out of scope unless trivial: lazy ranged reads inside `read()` for
  read-only streams so a 100 MB file opened and read sequentially never fully
  materialises in WASM memory. The current design keeps whole-file-in-worker
  semantics and only removes the transport cap; note it as follow-up.

### HTTPFS and `jb_http` (`python3/worker.ts:1005-1250`)

`createHTTPFS.close` receives `{ body: Uint8Array, ... }` from
`backend.httpRequest`. Store the metadata JSON in `lastResponse` as before,
with `bodyLength`, and store the body bytes separately in `lastBody`. Expose
the body as a second virtual file `/_jb_http/body`: `lookup` creates it,
`getattr` reports `lastBody.length`, `open` for read sets `stream.hostContent =
lastBody`. The generated Python then becomes:

```python
def _do_request(self, method, url, headers=None, body=None):
    req = _json.dumps({'url': url, 'method': method, 'headers': headers, 'body': body})
    with _orig_open('/_jb_http/request', 'w') as f:
        f.write(req)
    with _orig_open('/_jb_http/request', 'r') as f:
        meta = _json.loads(f.read())
    content = b''
    if meta.get('bodyLength'):
        with _orig_open('/_jb_http/body', 'rb') as f:
            content = f.read()
    meta['_content'] = content
    return meta
```

and `_JbHttpResponse.__init__` takes `self.content = data.get('_content', b'')`
with the `bodyBase64` branch removed. The `text` property decodes lazily.

### js-exec worker

- `fs.readFile` / `fs.readFileBuffer` / `fs.writeFile` shims: unchanged call
  sites, because `SyncBackend.readFile` and `writeFile` now stream internally.
- `fetch` polyfill: `raw.body` is now bytes. `Response.text()` decodes with
  `TextDecoder`, `arrayBuffer()` returns the bytes, `json()` parses the decoded
  text. This also fixes the polyfill's current behaviour of treating every body
  as a string.
- Regenerate the bundled worker so its inlined protocol constants match.
  Extend `scripts/check-worker-sync.js` to cover it if it is produced from a
  TypeScript source; if it is hand-maintained, add a test that imports
  `protocol.ts` and asserts the bundled file contains the same `TOTAL`.

### Limits and messages

- `maxFileSize` stays sourced from `executionLimits.maxStringLength` for
  `python3` (`python3.ts:520`). Consider a dedicated
  `executionLimits.maxWorkerFileSize` in a follow-up; not required here because
  after this PR raising `maxStringLength` actually works.
- Host `BridgeHandler` enforces the same `maxFileSize` on chunked writes.
- Error text when a limit binds: `file exceeds maxFileSize (N bytes); raise
  executionLimits.maxStringLength` for files, and the unchanged
  `Response body too large (max: N bytes)` from `secureFetch` for HTTP, which now
  reaches the worker instead of being pre-empted by the transport.
- Document in `limits.ts` that the bridge no longer imposes a size ceiling.

## Alternative considered: make `DATA_BUFFER` configurable instead

A smaller PR could thread a buffer size from `executionLimits` into
`createSharedBuffer(size)` and `WorkerInput`, leaving the whole-file protocol as
is. It is worth understanding why streaming is the better upstream proposal,
because a reviewer will ask.

- **It moves the wall, it does not remove it.** Whatever value is chosen becomes
  the new opaque `Data too large` failure. Streaming makes the transport
  size-agnostic and leaves only the two documented limits.
- **Memory scales with the cap, not with use.** The buffer is allocated per
  execution (`createSharedBuffer()` is called once per `python3` or `js-exec`
  run). A 64 MB cap means every concurrent worker owns a 64 MB shared region,
  and because the worker copies whole payloads into it, the pages are touched.
  Ten concurrent Python executions would commit 640 MB of bridge buffers to
  move a few kilobytes of source files each. Streaming keeps the 8 MB region and
  pays for large files only when they occur.
- **It does not fix HTTP.** Bodies would still be base64 inside a JSON result,
  so the effective HTTP ceiling stays at roughly three quarters of the buffer
  and the host still makes three copies.
- **It does not fix `rename`.** The read-write-rm copy remains.
- **The QuickJS side has its own 64 MB heap limit.** The existing comment at
  `protocol.ts:99-101` sizes the buffer to stay "well under the 64 MB QuickJS
  memory limit per execution". A configurable buffer approaching that value
  would let a single `fs.readFile` exhaust the guest heap.

Where a configurable size does make sense is as a tuning knob for the *chunk*
size once streaming exists, for embedders who want a smaller shared region per
worker (for example 1 MB on memory-constrained hosts, at the cost of more round
trips for large files). That is a natural follow-up: `createSharedBuffer(size)`
with the chunk loops reading `Size.DATA_BUFFER` from the buffer's actual length
instead of the constant. Keep it out of this PR to keep the diff reviewable.

If a stopgap is needed in the fork before upstream merges, raising the constant
is a one-line change, but it should be treated as a fork patch, not a proposal.

## Implementation plan, file by file

| File | Change |
|---|---|
| `src/commands/worker-bridge/protocol.ts` | new opcodes, `ARG_OFFSET`/`ARG_LENGTH`, `Flags.CHUNK_*`, accessors, `reset()`, updated `Size`/`Offset`, export `Size` for consumers |
| `src/commands/worker-bridge/sync-backend.ts` | `execSync` optional `argOffset`/`argLength`; `readFileRange`, `readFileAll`, `writeFileChunked`; `readFile`/`writeFile` delegate; `httpRequest` returns bytes via handle; `FileTooLargeError` |
| `src/commands/worker-bridge/bridge-handler.ts` | `maxFileSize` ctor arg; `handleReadFileRange`, `handleWriteFileChunk`, `handleHttpReadBody`, `handleHttpReleaseBody`; read cache and invalidation; body handle store with bounds; discard staging and handles in `stop()`/`handleExit()`; `handleHttpRequest` returns metadata |
| `src/commands/python3/worker.ts` | HOSTFS `open` uses `readFileAll` with `EFBIG` mapping; `rename` uses `backend.rename`; `setattr` uses `readFileAll`; HTTPFS `body` node; `generateHttpBridgeCode` reads `/_jb_http/body` |
| `src/commands/python3/python3.ts` | pass `maxFileSize` to `BridgeHandler` |
| `src/commands/js-exec/*` | fetch polyfill body as bytes; rebuild worker bundle; sync check |
| `src/limits.ts` | doc comment on `maxStringLength` mentioning worker file size |
| `scripts/check-worker-sync.js` | cover js-exec worker if generated |
| `.changeset/*.md` | see below |
| `AGENTS.npm.md` / README python3 and js-exec sections | remove any "8 MB" statements, describe the limits that apply |

Suggested commit sequence, each independently reviewable:

1. `protocol: add ARG_OFFSET/ARG_LENGTH header fields and READ_FILE_RANGE / WRITE_FILE_CHUNK opcodes` (protocol + sync-backend + bridge-handler + tests, no consumer changes).
2. `python3: HOSTFS reads and writes go through ranged/chunked ops; rename uses RENAME` (+ wasm tests).
3. `bridge: HTTP bodies returned via handle instead of base64 in result` (protocol + handler + sync-backend + HTTPFS + jb_http + js-exec fetch + tests).
4. `js-exec: regenerate worker bundle; add sync check`.
5. `docs + changeset`.

## Tests

### `src/commands/worker-bridge/bridge-handler.test.ts` (unit, no WASM)

Using the existing `sendOp` helper extended with `argOffset`/`argLength`:

- `READ_FILE_RANGE returns the requested slice and reports total size` on a
  20 MB `InMemoryFs` file: ranges at 0, 8 MB, 16 MB; last range shorter; range
  past EOF returns empty with `SUCCESS`.
- `READ_FILE_RANGE serves subsequent ranges from the read cache` by wrapping
  `readFileBuffer` in a counting spy: one call for three ranges.
- `read cache is invalidated by WRITE_FILE_CHUNK, RM, RENAME`.
- `WRITE_FILE_CHUNK assembles three chunks into one writeFile` with a spy
  asserting exactly one `writeFile` call and byte-identical content.
- `WRITE_FILE_CHUNK rejects out-of-sequence offsets and a chunk without FIRST`.
- `WRITE_FILE_CHUNK enforces maxFileSize before writing`.
- `stop() during a partial chunked write leaves the target untouched`.
- `HTTP_REQUEST returns metadata and a handle; HTTP_READ_BODY streams; RELEASE frees`
  with a `SecureFetch` stub returning a 12 MB body.
- `body handle store evicts oldest when over budget`.
- `HTTP_REQUEST inlines bodies at or below 256 KB as bodyBase64` (if the
  inline optimisation is kept).
- Existing `raceDeadline` tests still pass.

### `src/commands/python3/*.test.ts` (WASM, `pnpm test:wasm`)

With `executionLimits.maxStringLength` raised to 64 MB in the `Bash` options:

- write 20 MB from Python with `open(p,'wb').write(os.urandom(...))`, read it
  back from the shell with `sha256sum`, and compare to Python's `hashlib`.
- read a 20 MB file created by the shell: `len(open(p,'rb').read())`.
- `os.rename` of a 12 MB file; `readFileBuffer` on the host was not called
  (spy on the fs), and content is intact.
- `os.truncate` on a 12 MB file to 10 MB.
- with the default 10 MB limit, an 11 MB read raises `OSError` with errno 27
  and the message names the limit.
- `jb_http.get` against a local `SecureFetch` stub returning a 9 MB body:
  `len(r.content) == 9 MB`, `r.text` decodes, and a 1 KB body still works.
- a `SecureFetch` that throws `ResponseTooLargeError` surfaces its message in
  Python unchanged.

### `src/commands/js-exec/*.test.ts`

- `fs.readFileBuffer` and `fs.writeFile` of a 12 MB file round-trip.
- `fetch()` of a 9 MB body: `await r.arrayBuffer()` has the right length,
  `await r.text()` decodes, `await r.json()` on a small body still works.

### Sync and lint

- `pnpm typecheck && pnpm lint && pnpm check:worker-sync && pnpm test:unit && pnpm test:wasm`.
- `scripts/check-banned-patterns.js` runs as part of `lint`; the new code uses
  the same `_Atomics`/`_SharedArrayBuffer` trusted globals as the existing
  protocol code.

## Security review notes

- **Bounds.** Every offset and length from the worker is validated as a safe
  non-negative integer before use; length is capped at `DATA_BUFFER`; staged
  writes are capped at `maxFileSize`; body handles are bounded in count and
  bytes. A hostile guest cannot make the host allocate more than it can today
  plus one `maxFileSize` staging buffer.
- **Single in-flight write.** Only one staging buffer exists; a `CHUNK_FIRST`
  for a different path discards the previous one. This prevents a guest from
  parking many partial files on the host.
- **No new paths.** Path resolution and error sanitisation are unchanged
  (`resolvePath`, `sanitizeErrorMessage`). `READ_FILE_RANGE` and
  `WRITE_FILE_CHUNK` resolve exactly as `READ_FILE` and `WRITE_FILE` do.
- **Deadline.** All new handlers are synchronous with respect to the fs promise
  and run inside the existing `run()` loop, so the overall `timeoutMs` and the
  per-op `Atomics.wait` timeout apply unchanged. `HTTP_READ_BODY` performs no
  I/O.
- **Cleanup.** `stop()` and `EXIT` drop staging and body handles, so a
  terminated worker leaves no host memory behind.
- **Atomicity for embedders.** One `writeFile` per file is preserved, which
  matters for transactional and content-addressed `IFileSystem`
  implementations.
- **Defense in depth.** The new handlers do not touch host globals beyond
  what the existing handlers use; nothing new needs `DefenseInDepthBox`.

## Performance

- Files at or below 8 MB: identical op count to today for reads (one op) and
  writes (one op), plus 16 bytes of header.
- Files above 8 MB: `ceil(n / 8 MB)` ops each way, one `readFileBuffer` on the
  host thanks to the cache, one `writeFile` thanks to staging.
- HTTP: the base64 and JSON-string copies disappear. For a 6 MB body that is
  about 16 MB less transient host memory and two fewer full-body encode passes.
  Bodies over 6 MB go from impossible to `1 + ceil(n / 8 MB) + 1` ops.
- `rename` of an n-byte file goes from 2n bytes across the bridge to zero.

## Backward compatibility

- Public API: none of `Bash`, `ExecutionLimits`, `NetworkConfig`,
  `IFileSystem`, or command behaviour changes shape. Behaviour changes only in
  that operations which used to fail above 8 MB now succeed up to the configured
  limits, and error messages for the configured limits are now reachable.
- Internal: `SyncBackend.httpRequest` return type changes. Both call sites are
  in-package.
- The shared buffer grows by 16 bytes.
- Embedders who relied on the 8 MB transport failure as an implicit cap should
  set `executionLimits.maxStringLength` (files) and `network.maxResponseSize`
  (HTTP) explicitly; call this out in the changeset.

## Changeset

```md
---
"just-bash": minor
---

worker bridge: stream large files and HTTP bodies instead of failing above 8 MB

The SharedArrayBuffer bridge used by `python3` and `js-exec` moved every file
and HTTP response through one 8 MB region, so reads, writes and fetches above
that size failed with `Data too large` regardless of the configured
`executionLimits.maxStringLength` or `network.maxResponseSize`. Reads are now
served in ranges, writes are sent in chunks and assembled on the host into a
single `writeFile`, and HTTP bodies are read through a handle instead of being
base64-encoded into the result. File and response sizes are now bounded only by
those two configured limits, and the errors name them. HOSTFS `rename` uses the
existing `RENAME` op instead of copying contents through the bridge.

Embedders that relied on the transport failure as an implicit size cap should
set `maxStringLength` and `maxResponseSize` explicitly.
```

## PR description outline

1. Problem, with the three disagreeing limits table from "Background".
2. What changes, the one-paragraph summary above.
3. Design notes: why chunk assembly on the host rather than `appendFile`; why
   a body handle rather than a temp file in the sandbox filesystem (a temp file
   would create a real file, and on persistent or content-addressed
   `IFileSystem` backends that means a stored blob and a GC obligation for a
   transient response).
4. Test matrix.
5. Compatibility and the explicit-limits note.

## Relationship to sql-fs-api's host-side unzip

This PR removes the transport ceiling. It does not change what `pip install`
in sql-fs-api should do, and host-side unzip stays in the v2 plan for reasons
the bridge cannot address:

- Extraction through the bridge still boots one CPython worker per wheel
  (~80 MB, ~1 s) where host-side unzip boots none.
- Each extracted file is still two `writeFile` calls (`mknod` empty, then
  `close` full) plus a `stat` per path component and a `mkdir` per directory,
  each of which is a Postgres round trip pair on SqlFs. Host-side unzip feeds
  `bulkIngest`, which is a constant number of statements per batch.
- Chunking makes large files *more* round trips through the bridge, not fewer.
- The wheel would still round-trip through the sandbox filesystem as a blob,
  a content-cache entry and a Redis entry before extraction.
- Per-file hashes for the package manifest come free from host-side inflate;
  through the bridge they require a second pass.
- The upstream fix arrives when it is merged and released; the sql-fs-api
  change ships on its own schedule.

What this PR does fix for sql-fs-api is the two remaining cases after
host-side unzip: Python code reading or writing files larger than 8 MB at
runtime, and `databricks` CLI responses above roughly 6 MB. Once sql-fs-api
upgrades to a just-bash release containing it, the "known runtime limits" note
in SECURITY.md can be removed and `maxStringLength` raised to whatever the
per-session memory budget allows.
