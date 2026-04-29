# Models reference

All models are **frozen dataclasses** (immutable). Field names use Python
snake_case; the SDK translates server-side camelCase fields when parsing
responses.

```python
from virtualfs import (
    SandboxRecord, SandboxInfo,
    ExecResult, BatchExecResult, StreamEvent,
    TreeEntry, ReadResult, FileStat,
)
```

---

## `SandboxRecord` — returned by `sandboxes.create()` and `.list()`

| Field | Type | Notes |
|---|---|---|
| `id` | `str` | Sandbox UUID |
| `name` | `str \| None` | Human label, optional at creation |
| `owner` | `str` | The `sub` claim of the creating token |
| `created_at` | `str` | ISO-8601 UTC |
| `python` | `bool` | CPython WASM runtime enabled? |
| `javascript` | `bool` | QuickJS runtime enabled? |

```python
sb = fs.sandboxes.create(name="demo", python=True)
print(sb.record.id, sb.record.python)
```

---

## `SandboxInfo` — returned by `sandboxes.get()`

Same as `SandboxRecord` minus the `python`/`javascript` flags, plus
`last_used_at`.

| Field | Type | Notes |
|---|---|---|
| `id` | `str` | |
| `name` | `str \| None` | |
| `owner` | `str` | |
| `created_at` | `str` | ISO-8601 UTC |
| `last_used_at` | `str` | ISO-8601 UTC; touched by every exec call |

---

## `ExecResult` — returned by `sb.exec()`

The headline result type. Designed for direct attribute access — no JSON
parsing required.

| Field / property | Type | Notes |
|---|---|---|
| `stdout` | `str` | Captured stdout (UTF-8 decoded server-side) |
| `stderr` | `str` | Captured stderr |
| `exit_code` | `int` | 0 = success |
| `exit_signal` | `str \| None` | Set if the process was terminated by signal |
| `timed_out` | `bool` | True if the script hit `timeout_ms` |
| `duration_ms` | `int` | Wall-clock duration of the script |
| `ok` | `bool` (property) | Convenience: `exit_code == 0` |
| `error` | `str` (property) | **Alias for `stderr`** — matches issue #29 ergonomics |

```python
r = sb.exec("ls /home/user")
if not r.ok:
    raise RuntimeError(f"ls failed (exit {r.exit_code}): {r.error}")
files = r.stdout.splitlines()
```

**Note on `r.error`:** it returns the captured stderr text. It does **not**
indicate transport-level errors — those raise exceptions. A 0-exit script with
content on stderr will still have `r.ok == True` and a non-empty `r.error`.

---

## `BatchExecResult` — one entry in `sb.exec_batch()` results

| Field / property | Type | Notes |
|---|---|---|
| `id` | `str` | Echo of the input id; lets you correlate scripts to results |
| `stdout` | `str` | |
| `stderr` | `str` | |
| `exit_code` | `int` | `-1` if the batch budget was exhausted before this script ran |
| `error` | `str \| None` | Set when the server itself errored on this entry (e.g. `"timeout"`) |
| `ok` | `bool` (property) | `exit_code == 0` |

```python
results = sb.exec_batch([...])
by_id = {r.id: r for r in results}
if not by_id["tree"].ok:
    ...
```

---

## `StreamEvent` — yielded by `sb.exec_stream()`

A tagged union over three SSE event types. Inspect `.type` first.

| Field | Type | Set when |
|---|---|---|
| `type` | `Literal["stdout", "stderr", "exit"]` | always |
| `data` | `str \| None` | `type in {"stdout", "stderr"}` — the chunk text |
| `t` | `float \| None` | server-side timestamp (seconds since exec start) |
| `exit_code` | `int \| None` | `type == "exit"` |
| `duration_ms` | `int \| None` | `type == "exit"` |
| `error` | `str \| None` | `type == "exit"` if the server short-circuited |

```python
for ev in sb.exec_stream("..."):
    if ev.type == "stdout":
        write(ev.data)
    elif ev.type == "stderr":
        warn(ev.data)
    elif ev.type == "exit":
        if ev.exit_code != 0:
            raise RuntimeError(f"exec failed in {ev.duration_ms}ms: {ev.error}")
```

---

## `TreeEntry` — banned for agent use (returned by `sb.fs.tree()`)

Documented for completeness. Agents should use `sb.exec("find ... -printf ...")` instead.

| Field | Type | Notes |
|---|---|---|
| `path` | `str` | Absolute path |
| `kind` | `Literal["file", "dir", "symlink"]` | |
| `size` | `int` | Bytes; 0 for directories |
| `mtime` | `str` | ISO-8601 UTC |

---

## `ReadResult` — banned for agent use (returned by `sb.fs.read()`)

| Field | Type | Notes |
|---|---|---|
| `content` | `bytes` | Raw file body |
| `stat` | `FileStat \| None` | Parsed `X-FS-Stat` response header |
| `text(encoding="utf-8")` | method | Decode `content` as text |

---

## `FileStat` — banned for agent use

| Field | Type |
|---|---|
| `kind` | `Literal["file", "dir", "symlink"]` |
| `mode` | `int` |
| `size` | `int` |
| `mtime` | `str` |
