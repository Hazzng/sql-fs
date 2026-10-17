# Bash execution

Clients run bash scripts inside a sandbox and get stdout, stderr, and the exit code back. They can do this synchronously, as a Server-Sent Events stream, or as a batch. A script's file writes persist. Read-only mode rejects mutations, and a timeout stops the script while keeping the work it already committed.

## Sub-features

- `exec-sync` returns `{exitCode, stdout, stderr}` and persists writes.
- `exec-sse` streams `stdout` events and exactly one `exit` event.
- `exec-batch` runs ordered scripts and returns results keyed by `id`.
- `exec-readonly` rejects mutation with `422 EREADONLY_VIOLATION` and leaves no file.
- `exec-timeout` returns `408 EXEC_TIMEOUT` and keeps the completed prefix.

## How to get to it (user POV)

- REST: `POST /v1/sandboxes/:id/exec-sync`, `/exec` (SSE), `/exec-sync-batch`.
- MCP: `bash_exec`, `bash_exec_batch`.

## Driving it with stack.sh

Preconditions:

- Baseline from the [index](./README.md), and `ID` from a fresh sandbox.

- **Sync run and persistence.** Run `$S api POST /v1/sandboxes/$ID/exec-sync --json '{"script":"echo hi > /home/user/a.txt; cat /home/user/a.txt"}' | jq -c '{exitCode,stdout}'`. The output is `{"exitCode":0,"stdout":"hi\n"}`. Then `$S api GET /v1/sandboxes/$ID/files/home/user/a.txt` prints `hi`.
- **Read-only rejection.** Run `EXPECT=422 $S api POST /v1/sandboxes/$ID/exec-sync --json '{"script":"echo x > /home/user/ro.txt","readOnly":true}'`. The `code` is `EREADONLY_VIOLATION`. Then `EXPECT=404 $S api GET /v1/sandboxes/$ID/files/home/user/ro.txt` confirms no file was written.
- **SSE stream.** Run `$S api POST /v1/sandboxes/$ID/exec --json '{"script":"printf stream-proof"}'`. The output contains `event: stdout` with `"data":"stream-proof"` and exactly one `event: exit` with `"exitCode":0`.
- **Batch.** Run `$S api POST /v1/sandboxes/$ID/exec-sync-batch --json '{"scripts":[{"id":"a","script":"echo one"},{"id":"b","script":"echo two"}]}' | jq -c '[.results[]|[.id,.exitCode,.stdout]]'`. The output is `[["a",0,"one\n"],["b",0,"two\n"]]`.
- **Timeout prefix.** Run `EXPECT=408 $S api POST /v1/sandboxes/$ID/exec-sync --json '{"script":"echo p > /home/user/p.txt; sleep 2; echo s > /home/user/s.txt","timeoutMs":100}'`. The `code` is `EXEC_TIMEOUT`. Then `$S api GET /v1/sandboxes/$ID/files/home/user/p.txt` prints `p` and `EXPECT=404 $S api GET /v1/sandboxes/$ID/files/home/user/s.txt` succeeds.
- **Worker modes.** Repeat the sync run after `SERVER_ENV="SQL_FS_WORKERS_ENABLED=false" $S restart --no-build`, then restore with `SERVER_ENV= $S restart --no-build`. Both modes must give identical results.

## Gotchas

- A non-zero script exit is still HTTP `200`. Assert `exitCode`, not just the status.
- Python and JavaScript commands need the runtime enabled (`PATCH {"python":true}`). The first `python3` call can take tens of seconds.
- Output above `SQL_FS_WORKER_OUTPUT_BYTES` fails with exit `126`. `$S suite output-cap` covers both worker modes.
- The outcome of an `exec` or `execBatch` is unknown after `503` with code `EEXEC_OUTCOME_UNKNOWN`, `EDRIVERFAULT`, or `ECOHERENCE` (writes may have been applied), or after an SDK `TransportError` starting with `network error after` or `script outcome unknown`. Never retry those automatically. Read the sandbox state before running anything else. `worker-failures` covers them.
