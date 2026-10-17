# Files

Clients read and write sandbox files directly, without bash. They can write raw bytes, edit a string in place, write many files at once, create directories, list a tree, and delete. Every change is visible to bash and to other replicas.

## Sub-features

- `files-put-get` writes raw bytes (`204`) and reads them back exactly.
- `files-edit` replaces `oldString` with `newString` and reports `replacements`.
- `files-bulk` writes several files with `writeFiles` (`204`).
- `files-mkdir` creates directories recursively (`204`).
- `files-tree` lists entries under a prefix to a given depth.
- `files-delete` removes a file (`204`), after which reads return `404 ENOENT`.

## How to get to it (user POV)

- REST: `GET|PUT|PATCH|DELETE /v1/sandboxes/:id/files/<path>`, `POST /v1/sandboxes/:id/writeFiles`, `POST /v1/sandboxes/:id/mkdir`, `GET /v1/sandboxes/:id/tree?prefix=&depth=`.
- MCP: `file_read`, `file_write`, `file_edit`.

## Driving it with stack.sh

Preconditions:

- Baseline from the [index](./README.md), and `ID` from a fresh sandbox.

- **Mkdir.** Run `EXPECT=204 $S api POST /v1/sandboxes/$ID/mkdir --json '{"path":"/home/user/v","recursive":true}'`.
- **Raw write and read.** Run `EXPECT=204 $S api PUT /v1/sandboxes/$ID/files/home/user/v/note.txt --data-binary $'before\n' -H 'Content-Type: application/octet-stream'`, then `$S api GET /v1/sandboxes/$ID/files/home/user/v/note.txt`. It prints `before`.
- **Edit.** Run `$S api PATCH /v1/sandboxes/$ID/files/home/user/v/note.txt --json '{"oldString":"before","newString":"after"}' | jq .replacements`. It prints `1`, and a second GET prints `after`.
- **Bulk write, seen by bash.** Run `EXPECT=204 $S api POST /v1/sandboxes/$ID/writeFiles --json '{"files":{"/home/user/v/one.txt":"one\n","/home/user/v/two.txt":"two\n"}}'`, then `$S api POST /v1/sandboxes/$ID/exec-sync --json '{"script":"cat /home/user/v/one.txt /home/user/v/two.txt","readOnly":true}' | jq -r .stdout`. It prints `one` and `two`.
- **Tree.** Run `$S api GET "/v1/sandboxes/$ID/tree?prefix=/home/user/v&depth=3" | jq -c '[.[].path]'`. The output lists `note.txt`, `one.txt`, and `two.txt` under `/home/user/v/`.
- **Delete.** Run `EXPECT=204 $S api DELETE /v1/sandboxes/$ID/files/home/user/v/note.txt`, then `EXPECT=404 $S api GET /v1/sandboxes/$ID/files/home/user/v/note.txt`. The body is `{"error":"not_found","code":"ENOENT"}`.

## Gotchas

- The path in `/files/<path>` has no leading slash after `files/`. The server treats it as absolute.
- Quote URLs that contain `?` or `&`, or the shell will mangle the request.
- Null bytes and path traversal are rejected. Symlinks are allowed by default, with bounded resolution.
- Write bodies have size limits (`MAX_BULK_WRITE_BYTES` and others). See `docs/CONFIGURATION.md` before writing large-file journeys, and `scripts/verify/large-files.mjs` for profiling.
