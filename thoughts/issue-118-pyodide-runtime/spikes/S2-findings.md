# S2 — IPC integrity (gates Phase 3/4)

## GATE: ✅ PASS — with a load-bearing finding (see "Finding A")

`s2-ipc.ts`, run with the bootstrapped Deno **under the committed deny-belt**,
exits **0** and prints:

```
 PASS realm-lockdown blocks deletable primitives [Deno=blocked,console=blocked,require=blocked]
NOTE lockdown is NOT sufficient: import("node:fs").writeSync(1,…) reaches stdout under the deny-belt
NOTE => Node-side frame validation with secret generation/requestId is LOAD-BEARING (design.md D1)
PASS forge-resistance: guessed-secret frame rejected
PASS ready handshake accepted once
PASS duplicate-ready rejected
PASS ready-after-response rejected
PASS wrong-generation-ready rejected
PASS baseline ready + result accepted
PASS forged-frame rejected
PASS interleave rejected
PASS replay rejected
PASS stale-generation rejected
PASS oversized rejected
S2 ALL PASS
```

> The **leading space** on the first line is not cosmetic — it is the single
> `0x20` byte the adversary wrote to fd 1 via `import("node:fs")`. Its presence
> on the wire IS the evidence for Finding A.

The spike now models the **actual post-S1 runner realm**: it installs the same
Node-compat globals the real `runner.ts` must (`require` via `createRequire`,
`__dirname`, `__filename`) and locks them down, so the adversary faces the realm
untrusted code will truly see. **This confirms the committed design** (design.md
Decision 1) — it does not re-choose a transport.

Invocation (no `--allow-read` needed — and, per Finding A, the node:fs import +
stdout write need no permission either):
```
DENO_NO_UPDATE_CHECK=1 deno run --no-prompt --deny-net --deny-run --deny-write \
  --deny-env --deny-ffi --deny-sys --deny-import --no-remote --no-npm \
  --cached-only --no-config s2-ipc.ts
```

## Finding A (HIGH) — realm lockdown is hardening, NOT stdout containment

After capturing the writer and deleting `Deno`, `console`, `require`,
`__dirname`, `__filename` from `globalThis`:
- `Deno.stdout.write` → **blocked** (Deno deleted)
- `console.log` → **blocked** (console deleted)
- `require("fs")` → **blocked** (require deleted)
- **`(await import("node:fs")).writeSync(1, bytes)` → SUCCEEDS — writes to stdout.**

Why the last one cannot be stopped by lockdown:
1. `import(...)` is **syntax**, not a deletable global.
2. `node:` builtins are **not** gated by `--deny-import`/`--no-npm` (those gate
   remote/npm only).
3. `--deny-write` does **not** block writes to the **already-open stdout fd**.

A dedicated control fd (e.g. fd 3) does **not** fix this either: `fs.writeSync(N,…)`
works for **any** open fd. The correct, sufficient defense is therefore the
**Node-side frame validation with secret integrity fields**, which design.md
Decision 1 already mandates. **This makes Node-side validation LOAD-BEARING, not
"defense-in-depth."**

## Finding B — why the bypass cannot actually forge an accepted frame

Every frame carries a random **requestId**, monotonic **seq**, and
child-**generation** id. These are held only by Node and the runner's closure and
are **never exposed to untrusted Python** (the runner passes only `code` to
`runPythonAsync`). An attacker who can write bytes to stdout therefore:
- **cannot forge an accepted frame** — it must GUESS the secrets; the validator
  KILLS the child on any mismatch (spike: `forge-resistance: guessed-secret frame
  rejected`);
- **cannot replay a real frame** — a process cannot read its own stdout pipe;
- **can only corrupt/interleave** → a malformed/oversized/out-of-sequence frame →
  Node kills the child (self-DoS of that one session, no escalation).

## What the validator enforces (kill on ANY anomaly)

**One-time `ready` handshake** — `{ type:"ready", generation }`, NO requestId/seq
(matches plan.md:357). Valid **once**, **before any response**, **current
generation only**. Rejected (→ kill): `duplicate-ready`, `ready-after-response`,
`wrong-generation-ready`.

**Per-request responses** — `result|error` with `{ requestId, seq, generation }`.
Rejected (→ kill): `oversized` (cap measured on **encoded wire size**),
`stale-generation`, `forged-type`, `forged-requestId` (never issued),
`duplicate-response` (replay — one response per requestId), `out-of-sequence`
(interleave — seq must strictly increase per generation).

## Mandatory requirements for Phase 3/4 (carry forward)

1. **Phase 3 `runner.ts` lockdown must delete `require`, `__dirname`, `__filename`
   in addition to `Deno`/`console`** (plan.md:371 said only "Deno, console, and
   other write primitives" — these ARE the "other" ones, now named explicitly).
2. **`runner.ts` MUST NOT expose `requestId`/`seq`/`generation` to untrusted
   Python** (keep them in JS closure; pass only `code`/`argv`/`stdin`/`files` into
   Pyodide). If they leak, Finding B's guarantee collapses.
3. **Phase 4 Node side MUST validate every frame and kill on the first anomaly** —
   this is the primary control, not optional hardening. Re-enforce cwd
   path-validation + size caps on drain regardless of frame contents.
4. The integrity fields must be **unguessable** (random requestId; monotonic seq;
   generation bumped on every respawn).
