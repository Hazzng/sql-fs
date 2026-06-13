# F9b: Boot-assert SESSION_IDLE_MS below version-key TTL

## Overview

The distributed cache-coherence proof assumes the session idle-eviction window
is comfortably shorter than the Redis version-key TTL (`vfs:{tenant}:ver:*`).
No boot assertion enforces this, so an operator who raises `SESSION_IDLE_MS`
(or `MCP_SESSION_IDLE_MS`) above the TTL silently re-opens the counter
reset-to-1 wrap that the TTL is designed to prevent. This PR adds a fail-fast
boot assertion. Redis-less ("memory-only") deployments are unaffected.

## Current State

- `src/api/session-manager.ts:69` — `VERSION_KEY_TTL_SECONDS = 7 * 24 * 60 * 60`
  (SECONDS, = 7 days).
- `src/api/session-manager.ts:347` — constructor sets
  `this.idleMs = idleMs ?? Number(process.env.SESSION_IDLE_MS ?? "600000")`
  (MILLISECONDS). No assertion follows.
- `src/api/session-manager.ts:304` — `private readonly redis: Redis | undefined`,
  assigned at `:349`. The invariant only matters when Redis is in play.
- `src/api/mcp/server.ts:25` — `MCP_SESSION_IDLE_MS` (default 1_800_000 ms),
  a separate env-tunable idle window read at module load. Redis presence at this
  site is determined by `process.env.REDIS_URL`.

## Desired End State

Both idle-window configuration sites fail fast at boot, with a clear error
explaining the coherence invariant, when Redis is enabled and the idle window
is not comfortably below the version-key TTL. The unit conversion
(seconds → ms via `* 1000`) is explicit and correct; the margin variant
(`idleMs <= VERSION_KEY_TTL_SECONDS * 1000 / 2`) leaves reaper-tick + clock-skew
headroom. Memory-only deployments throw nothing.

## What We're NOT Doing

- Not closing the broader reset collision class (FLUSHALL / failover /
  maxmemory-eviction). That is the epoch/fence token in #131 (F2-L2) — a
  follow-up, not this PR.
- Not changing default values of `SESSION_IDLE_MS` / `MCP_SESSION_IDLE_MS`.
- Not modifying the version-counter protocol itself.

## Phase 1 — boot assertion + shared helper

### Changes

1. `src/api/session-manager.ts`: export
   `assertIdleBelowVersionTtl(idleMs: number, hasRedis: boolean): void` that
   throws an `Error` (with `code` "ERR_IDLE_TTL_INVARIANT") when
   `hasRedis && idleMs > VERSION_KEY_TTL_SECONDS * 1000 / 2`.
2. Call it in the SessionManager constructor immediately after
   `this.idleMs = ...` (`:347`) with `hasRedis = this.redis !== undefined`.
3. `src/api/mcp/server.ts`: call the shared helper at module load against
   `MCP_SESSION_IDLE_MS`, with `hasRedis` derived from `process.env.REDIS_URL`.

### Success Criteria

#### Automated

- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.
- [x] New unit test: helper throws with redis + over-bound idleMs; does NOT
      throw for sane idleMs, for the at-bound value, or when redis absent;
      verifies the `* 1000` conversion (just-under vs just-over
      `VERSION_KEY_TTL_SECONDS * 1000 / 2`).
- [x] Constructor throws when given a mock redis + over-bound `idleMs`.
- [x] `pnpm test:unit` green (no existing fixture regresses — audited: no
      redis-using fixture passes an explicit large `idleMs`).

#### Manual

- [ ] Boot the server with `REDIS_URL` set and `SESSION_IDLE_MS` above the bound
      → process exits with the invariant error. Unset `REDIS_URL` → boots fine.

### Discoveries

- MCP idle window is read at module-load time in `mcp/server.ts`, with no
  SessionManager reference, so the shared helper is keyed off
  `process.env.REDIS_URL` there rather than a live `Redis` instance.
- Audit result: every redis-using unit fixture relies on the default `idleMs`
  (600_000 ms ≈ 10 min), far below the 3.5-day bound. No fixtures need fixing.
