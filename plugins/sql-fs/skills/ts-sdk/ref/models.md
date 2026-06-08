# Models reference

All models are plain TypeScript `interface`s (parsed from the API's JSON).
Field names use camelCase, matching the server's response shape directly.
`ReadResult` is a class (it carries a `text()` helper); everything else is a
structural type.

```typescript
import {
  type SandboxRecord, type SandboxInfo,
  type ExecResult, type BatchExecResult, type StreamEvent,
  type TreeEntry, ReadResult, type FileStat,
  type FileKind, type StreamEventType,
} from "sql-fs-sdk";
```

---

## `SandboxRecord` — returned by `sandboxes.create()` and `.list()`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Sandbox UUID |
| `name` | `string \| null` | Human label, optional at creation |
| `owner` | `string` | The `sub` claim of the creating token |
| `createdAt` | `string` | ISO-8601 UTC |
| `python` | `boolean` | CPython WASM runtime enabled? |
| `javascript` | `boolean` | QuickJS runtime enabled? |

```typescript
const sb = await client.sandboxes.create({ name: "demo", python: true });
console.log(sb.record?.id, sb.record?.python);
```

---

## `SandboxInfo` — returned by `sandboxes.get()`

Same identity fields as `SandboxRecord` minus the runtime flags, plus
`lastUsedAt`.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | |
| `name` | `string \| null` | |
| `owner` | `string` | |
| `createdAt` | `string` | ISO-8601 UTC |
| `lastUsedAt` | `string` | ISO-8601 UTC; touched by every exec call |

---

## `ExecResult` — returned by `sb.exec()`

The headline result type. Designed for direct property access — no JSON
parsing required.

| Field / property | Type | Notes |
|---|---|---|
| `stdout` | `string` | Captured stdout (UTF-8 decoded server-side) |
| `stderr` | `string` | Captured stderr |
| `exitCode` | `number` | 0 = success |
| `exitSignal` | `string \| null` | Set if the process was terminated by signal |
| `timedOut` | `boolean` | True if the script hit `timeoutMs` |
| `durationMs` | `number` | Wall-clock duration of the script |
| `ok` | `boolean` (readonly) | Convenience: `exitCode === 0` |
| `error` | `string` (readonly) | **Alias for `stderr`** |

```typescript
const r = await sb.exec("ls /home/user");
if (!r.ok) throw new Error(`ls failed (exit ${r.exitCode}): ${r.error}`);
const files = r.stdout.split("\n").filter(Boolean);
```

**Note on `r.error`:** it returns the captured stderr text. It does **not**
indicate transport-level errors — those throw. A 0-exit script with content on
stderr will still have `r.ok === true` and a non-empty `r.error`.

---

## `BatchExecResult` — one entry in `sb.execBatch()` results

| Field / property | Type | Notes |
|---|---|---|
| `id` | `string` | Echo of the input id; lets you correlate scripts to results |
| `stdout` | `string` | |
| `stderr` | `string` | |
| `exitCode` | `number` | `-1` if the batch budget was exhausted before this script ran |
| `durationMs` | `number` | Wall-clock duration in ms; `0` if the script never ran (budget pre-exhausted or batch aborted) |
| `error` | `string \| undefined` | Set when the server itself errored on this entry (e.g. `"timeout"`) |
| `ok` | `boolean` (readonly) | `exitCode === 0` |

```typescript
const results = await sb.execBatch([...]);
const byId = new Map(results.map((r) => [r.id, r]));
if (!byId.get("tree")?.ok) {
  // ...
}
```

---

## `StreamEvent` — yielded by `sb.execStream()`

A tagged union over three SSE event types. Inspect `.type` first.

| Field | Type | Set when |
|---|---|---|
| `type` | `"stdout" \| "stderr" \| "exit"` | always |
| `data` | `string \| undefined` | `type` is `"stdout"` / `"stderr"` — the chunk text |
| `t` | `number \| undefined` | server-side timestamp (seconds since exec start) |
| `exitCode` | `number \| undefined` | `type === "exit"` |
| `durationMs` | `number \| undefined` | `type === "exit"` |
| `error` | `string \| undefined` | `type === "exit"` if the server short-circuited |

```typescript
for await (const ev of sb.execStream("...")) {
  if (ev.type === "stdout") write(ev.data ?? "");
  else if (ev.type === "stderr") warn(ev.data ?? "");
  else if (ev.type === "exit") {
    if (ev.exitCode !== 0) throw new Error(`exec failed in ${ev.durationMs}ms: ${ev.error}`);
  }
}
```

---

## `TreeEntry` — banned for agent use (returned by `sb.fs.tree()`)

Documented for completeness. Agents should use `sb.exec("find ... -printf ...")` instead.

| Field | Type | Notes |
|---|---|---|
| `path` | `string` | Absolute path |
| `kind` | `"file" \| "dir" \| "symlink"` | |
| `size` | `number` | Bytes; 0 for directories |
| `mtime` | `string` | ISO-8601 UTC |

---

## `ReadResult` — banned for agent use (returned by `sb.fs.read()`)

A class, not an interface — it carries a `text()` decode helper.

| Member | Type | Notes |
|---|---|---|
| `content` | `Uint8Array` | Raw file body |
| `stat` | `FileStat \| undefined` | Parsed `X-FS-Stat` response header |
| `text(encoding = "utf-8")` | method → `string` | Decode `content` as text |

---

## `FileStat` — banned for agent use

| Field | Type |
|---|---|
| `kind` | `"file" \| "dir" \| "symlink"` |
| `mode` | `number` |
| `size` | `number` |
| `mtime` | `string` |
