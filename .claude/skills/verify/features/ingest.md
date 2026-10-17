# Ingest

Clients upload a tree of files in one request as a JSON manifest of base64 contents under a `basePath`. They can get the tree back out as an archive by running `tar` in bash.

## Sub-features

- `ingest-manifest` writes every manifest entry under `basePath` and reports `fileCount`.
- `ingest-nested` creates nested directories from manifest keys.
- `ingest-export` round-trips the tree as a `tar.gz` produced by bash.

## How to get to it (user POV)

- REST: `POST /v1/sandboxes/:id/ingest-files` with `{"basePath":"...","files":{"rel/path":"<base64>"}}`.
- MCP: `fs_ingest`, `fs_export`.

## Driving it with stack.sh

Preconditions:

- Baseline from the [index](./README.md), and `ID` from a fresh sandbox.

- **Upload.** Run `$S api POST /v1/sandboxes/$ID/ingest-files --json "{\"basePath\":\"/home/user/in\",\"files\":{\"g.txt\":\"$(printf 'ingested\n' | base64)\",\"nested/two.txt\":\"$(printf 'two\n' | base64)\"}}"`. The body is `{"status":"ok","fileCount":2}`.
- **Bytes landed.** Run `$S api GET /v1/sandboxes/$ID/files/home/user/in/g.txt` and `$S api GET /v1/sandboxes/$ID/files/home/user/in/nested/two.txt`. They print `ingested` and `two`.
- **Export round-trip.** Run `$S api POST /v1/sandboxes/$ID/exec-sync --json '{"script":"tar -czf - -C /home/user/in . | base64 -w 0","readOnly":true}' | jq -r .stdout | base64 -d | tar -tzf -`. The listing contains `./g.txt` and `./nested/two.txt`.

## Gotchas

- HTTP ingest does not accept the host-filesystem `paths` form. That form is MCP-only.
- A manifest for a sandbox that does not exist returns `404 ENOENT`.
- Ingest has its own admission and byte budgets. `scripts/verify/ingest-admission.mjs` exercises them.
