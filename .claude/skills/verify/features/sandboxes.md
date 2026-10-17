# Sandboxes

A sandbox is a persistent, owner-scoped filesystem with optional Python and JavaScript runtimes. Owners can create one with seed files, read and list their own sandboxes, toggle runtimes, and delete them. Other owners cannot see or touch them.

## Sub-features

- `sandbox-create` creates a sandbox, optionally with seed `files`, and returns `201` with `id`.
- `sandbox-get` returns metadata including `owner`.
- `sandbox-list` lists only the caller's sandboxes.
- `sandbox-update` toggles `python`, `javascript`, and `network`.
- `sandbox-isolation` denies other owners with `403 FORBIDDEN`.
- `sandbox-delete` removes the sandbox and its files.

## How to get to it (user POV)

- REST: `POST /v1/sandboxes`, `GET /v1/sandboxes`, `GET|PATCH|DELETE /v1/sandboxes/:id`.
- MCP: `sandbox_create`, `sandbox_list`, `sandbox_update`, `sandbox_delete`.
- SDKs: `SqlFsClient` in `clients/typescript` and `sqlfs` in `clients/python`.

## Driving it with stack.sh

Preconditions:

- Baseline from the [index](./README.md).

- **Create with seed.** Run `ID=$(EXPECT=201 $S api POST /v1/sandboxes --json '{"name":"verify","files":{"/home/user/seed.txt":"seed\n"}}' | jq -r .id)`. `ID` is a UUID.
- **Seed persisted.** Run `$S api GET /v1/sandboxes/$ID/files/home/user/seed.txt`. The body is `seed`.
- **Metadata.** Run `$S api GET /v1/sandboxes/$ID | jq -c '{owner,name}'`. The output is `{"owner":"verify-agent","name":"verify"}`.
- **List.** Run `$S api GET /v1/sandboxes | jq '[.sandboxes[].id]'`. The output contains `$ID`.
- **Update runtime.** Run `$S api PATCH /v1/sandboxes/$ID --json '{"python":true}' | jq -c '{python,javascript,network}'`. The output is `{"python":true,"javascript":false,"network":false}`.
- **Isolation.** Run `EXPECT=403 AS=intruder $S api GET /v1/sandboxes/$ID` and `AS=intruder $S api GET /v1/sandboxes | jq '.sandboxes | length'`. The first returns `FORBIDDEN` and the second prints `0`.
- **Row stored.** Run `$S psql "select owner, python from sandboxes where id = '$ID'"`. One row reads `verify-agent | t`.
- **Delete.** Run `EXPECT=204 $S api DELETE /v1/sandboxes/$ID`, then `EXPECT=404 $S api GET /v1/sandboxes/$ID`. Then run `$S psql "select count(*) from dirents where sandbox_id = '$ID'"`, which prints `0`.

## Gotchas

- `PATCH` is `.strict()` and needs at least one of `python`, `javascript`, or `network`. A `name` is rejected with `400 INVALID_INPUT`.
- Seed `files` share the `writeFiles` count and byte caps.
- `psql` runs as superuser and bypasses RLS. Prove isolation through the API only.
