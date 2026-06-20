---
date: 2026-06-20T16:40:53+09:30
researcher: quangnguyentechno@gmail.com
git_commit: 87a08d67aefc8cce56cf6b34b80509ed2b4ad4b5
branch: main
repository: virtualFS
task: "Integrate just-git as a sandbox git custom command"
tags: [implementation-plan, session-manager, custom-commands, just-git, mcp, network]
status: draft
last_updated: 2026-06-20
last_updated_by: quangnguyentechno@gmail.com
---

# just-git Integration Implementation Plan

## Overview

Give every sandbox a real `git` command by registering [just-git](https://github.com/blindmansion/just-git)'s `createGit()` as a just-bash custom command. Local git ops (`init/add/commit/diff/log/status/branch/checkout`) work in every sandbox; network ops (`clone/fetch/push`) are gated by the existing `network` runtime flag. A single deployment-wide `GITHUB_TOKEN` (from the server `.env`) is **exported into every sandbox's shell environment** so agents can `git push` and `curl` the GitHub API (create issues/PRs) without supplying credentials per call; a per-request `env` value still overrides it. Close the MCP `sandbox_create` gap that hardcodes `network:false`, and correct stale "no network / no curl" comments.

> **Security model (decided):** one shared GitHub identity for all sandboxes, token readable by sandbox code, full outbound preserved. This is only safe for **trusted agents on a single-tenant deployment**. The hardened alternative (egress header-injection so the token never enters the sandbox; per-tenant scoping) was explicitly deferred — see *What We're NOT Doing* and *Security / Operational Assumptions*.

## Current State Analysis

- **The only integration point** is the `customCommands` array passed to `new Bash({...})` in `SessionManager.getOrCreate` — `src/api/session-manager.ts:549-568`. Today it conditionally registers `nodeCommand` when `resolvedRuntime.javascript` is true.
- **`network` is already a first-class create option in the HTTP API** — `src/api/routes/sandboxes.ts:22` (`network: z.boolean().optional()`), persisted to sandbox meta (`:109`,`:130`), returned (`:134`), and rehydrated on reconnect (`session-manager.ts:1075`,`:1123`). When true, `session-manager.ts:565` passes `network: { dangerouslyAllowFullInternetAccess: true }` to just-bash.
- **`curl` already works when `network:true`.** just-bash registers network commands (`curl`) whenever `options.fetch || options.network` is set (`just-bash Bash.ts:466`; `NetworkCommandName = "curl"`, registry.ts:101). The comment at `session-manager.ts:562` ("Bash itself remains air-gapped — no curl/wget/DNS") is **stale** and predates this just-bash version.
- **MCP `sandbox_create` cannot enable network** — it hardcodes `network: false` and omits the option entirely (`src/api/mcp/tools.ts:38-56`). Tool descriptions also still claim "no network" / "no curl/wget" (`tools.ts:170-179`).
- **No `git` command exists in the sandbox today.**
- **No base env is injected today.** The `new Bash({...})` call (`session-manager.ts:558`) passes no `env`, so sandboxes start with only just-bash's defaults. There is no server-configured `GITHUB_TOKEN` reaching sandboxes; the only env path is per-request `body.env`.

### Key Discoveries

- **Registration shape (verified):** `createGit(opts)` returns a `Git` instance with `readonly name = "git"` and an `execute(args, ctx)` method (`just-git src/git.ts:247,370,489`). Wrapping it with just-bash's `defineCommand("git", (args, ctx) => git.execute(args, ctx))` is the clean path because **`defineCommand` auto-sets `trusted: true`** (`just-bash custom-commands.ts:48` → `{ name, trusted: true, execute }`).
- **Defense-in-depth is solved by construction.** just-bash's `Command.trusted` flag runs the command inside `DefenseInDepthBox.runTrustedAsync()` (`just-bash types.ts:238-247`: "Use for trusted host-extension commands that need direct Node.js globals"). git does `fetch` + crypto (sha1) inside the `bash.exec` patched scope; `trusted: true` exits that scope for git's whole execution — the same reason the existing `nodeCommand` is trusted. No manual `runTrustedDbAsync`-style wrapping of git's fetch is required.
- **Network semantics (verified `just-git src/lib/transport/remote.ts:88-89`):** `validateNetworkAccess` returns "allowed" when `policy.allowed` is absent. So `createGit({ network: {} })` → full outbound via `globalThis.fetch`; `createGit({ network: false })` → transport blocked, local ops unaffected. One gate: `network: resolvedRuntime.network ? {} : false`.
- **git's egress path is `globalThis.fetch`**, independent of just-bash's `secureFetch`/`curl` path. For full-outbound (the chosen posture) both end up unrestricted and consistent with the existing `dangerouslyAllowFullInternetAccess` js-exec posture.
- **Identity/credentials ride per-request `env` — no plumbing:** just-git reads `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` (`just-git src/lib/identity.ts:7-11,64-65`) and `GIT_HTTP_BEARER_TOKEN` / `GIT_HTTP_USER`+`GIT_HTTP_PASSWORD` (`just-git src/lib/transport/remote.ts:110-115`), plus URL-embedded `https://token@host/…`, all per-command from `ctx.env`. The exec route already forwards `body.env` (`src/api/routes/exec.ts:32,170,198`) into `bash.exec(script, { env, … })` via `execWithRuntimeThrottle` (`session-manager.ts:1499,1512`).
- **Supply chain (verified):** just-git `1.7.1` declares **no** `dependencies`/`peerDependencies`/`optionalDependencies`; only `dist/` is published. The `pg`/`ssh2`/`better-sqlite3`/`bun:sqlite`/`cloudflare:workers` imports live exclusively in `src/server/` and `src/proxy/` (separate `just-git/server`, `just-git/proxy` entry points we never import). The client path (`createGit` from `"just-git"`) reaches only Node builtins (`node:crypto`, `node:zlib`) with WebCrypto/`CompressionStream` fallbacks — no WASM, satisfying the inherited just-bash constraint.
- **Version compatibility:** just-git `1.7.1` targets `just-bash ^3.0.1`; virtualFS pins `just-bash ^3.0.1` (`3.0.1` installed).
- **Base-env injection + per-request override (verified):** `new Bash({ env })` seeds the session shell env (`just-bash Bash.ts:116,332`, exported at `:431`); `bash.exec(script, { env })` *merges* over that env per call (`Bash.ts:249` — "merged with the current environment and restored after execution"). So a server-injected `GITHUB_TOKEN` is the default, and a per-request `body.env.GITHUB_TOKEN` overrides it for that exec. just-bash stores env in a `Map` (prototype-pollution-safe, `Bash.ts:321`).
- **git auth precedence (verified `just-git remote.ts:121-133`):** credential provider > env vars > cache. We therefore use the **env-var path** (`GIT_HTTP_BEARER_TOKEN`), *not* a static `createGit({ credentials })` provider — because a provider would outrank and silently ignore any per-request token, defeating override.
- **Hardened alternative (deferred):** just-bash supports egress header-injection — `AllowedUrl.transform` ("Transforms are applied at the fetch boundary so secrets never enter the sandbox", `just-bash network/types.ts:38`) — which would keep the token invisible to sandbox code. It requires an allowlist (`allowedUrlPrefixes`) and is mutually exclusive with `dangerouslyAllowFullInternetAccess`, so it conflicts with the chosen full-outbound posture. Recorded for a future hardening pass.

## Desired End State

- A sandbox can run `git init && git add . && git commit -m "x" && git log` with no `network` flag.
- With `network:true`, a sandbox can `git clone https://github.com/org/repo`, edit, `git commit`, and `git push` — using the server-configured `GITHUB_TOKEN` by default, with optional per-request override.
- With `network:true` and `GITHUB_TOKEN` set, `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/...` (e.g. `POST /repos/{o}/{r}/issues`, `POST /repos/{o}/{r}/pulls`) succeeds from the shell with no per-request credentials.
- When `GITHUB_TOKEN` is unset on the server, sandboxes behave exactly as before (no token in env); when `network:false`, no outbound at all.
- `curl` and `js-exec` `fetch` continue to work with `network:true` (unchanged).
- MCP-created sandboxes can opt into `network:true`.
- Stale "no network / no curl" comments/descriptions are corrected.
- `pnpm typecheck && pnpm lint:fix && pnpm test:unit` pass; a changeset is committed.

## What We're NOT Doing

- **No new `git` runtime flag.** git is always registered (decision: always-available). `RuntimeOptions`, the create schema's runtime flags, and meta persistence are NOT extended with a `git` field.
- **No host-allowlist / egress restriction.** Network posture is full outbound (matches existing js-exec). A `GIT_ALLOWED_HOSTS`-style allowlist (`NetworkPolicy.allowed`) is explicitly deferred.
- **No `curl` work.** It already exists when `network:true`.
- **No use of `just-git/server` or `just-git/proxy`** in production code (only optionally in tests, Phase 3).
- **No changes to just-bash or just-git source** — consumed as npm dependencies.
- **No per-tenant / per-owner token scoping.** A single deployment-wide `GITHUB_TOKEN` is shared by all sandboxes (decision). Multi-tenant credential isolation is deferred.
- **No hidden / egress-injected credentials.** We do NOT use just-bash `transform` header-injection or a `createGit({ credentials })` provider — the token is intentionally exported into the sandbox env (decision). Hardening deferred.
- **No secret persistence in the DB.** The token comes from server `process.env` only; it is never written to sandbox meta or any table. (It *is* visible inside the sandbox env by design — see assumptions.)

## Implementation Approach

Hybrid TDD: Phase 1 (command behavior) is test-first — assert git is registered and a local `init→add→commit→log` cycle works through `bash.exec`, then wire the registration. Phases 2–3 (MCP option, doc fixes, network integration test, changeset) are traditional wiring + verification.

---

## Phase 1: Add dependency + register git custom command

### Phase 1: Overview
Add `just-git`, construct a `Git` instance per session, register it (always) in `customCommands` with network gated on `resolvedRuntime.network`.

### Phase 1: Changes Required

#### 1. Dependency
**File**: `package.json`
**Changes**: `pnpm add just-git` (expect `just-git@^1.7.1`, zero transitive deps). Commit the updated `pnpm-lock.yaml`.

#### 2. Register the git command
**File**: `src/api/session-manager.ts` (imports near `:16`, customCommands at `:549-556`)
**Changes**: import `createGit`, build a trusted `git` command, push it unconditionally.

```typescript
// top imports
import { Bash, defineCommand } from "just-bash";
import { createGit } from "just-git";

// inside getOrCreate's creationPromise, replacing the customCommands block (~:549)
const git = createGit({
	// {} → no `allowed` list → full outbound via globalThis.fetch (remote.ts:88).
	// false → clone/fetch/push blocked; local git (init/add/commit/log) still works.
	network: resolvedRuntime.network ? {} : false,
});
// defineCommand sets trusted:true → git runs inside DefenseInDepthBox.runTrustedAsync,
// so its fetch + crypto are not flagged when JUST_BASH_DEFENSE_IN_DEPTH is on.
const gitCommand = defineCommand("git", (args, ctx) => git.execute(args, ctx));

const customCommands = [
	...(resolvedRuntime.javascript ? [nodeCommand] : []),
	gitCommand,
];
```

**Type-variance note:** just-git's `Git.execute` uses its own structurally-compatible *shadow* `CommandContext`/`ExecResult` (`just-git git.ts:42-50`), not exported. Write the call as above first. If `pnpm typecheck` flags a mismatch at the boundary (most likely `ctx.fs`: just-bash `IFileSystem` vs just-git `FileSystem`, or `ctx.stdin`), bridge with a single localized, commented cast — `git.execute(args, ctx as Parameters<typeof git.execute>[1])` — never `any` (per CLAUDE.md). The cast is runtime-safe: just-bash supplies `fs/cwd/env/stdin/exec/signal` that just-git reads.

#### 3. Inject the server `GITHUB_TOKEN` into the sandbox base env
**File**: `src/api/session-manager.ts` (a new small helper + the `new Bash({...})` call at `:558`)
**Changes**: build a base-env record from server config (read once, e.g. a module-level const or `SessionManager` field), and pass it as `env` to `new Bash`. Only include keys that are actually set, so behavior is unchanged when `GITHUB_TOKEN` is absent. `GITHUB_TOKEN` is aliased to `GIT_HTTP_BEARER_TOKEN` so just-git's env auth path (`remote.ts:110`) authenticates `git push` without URL-embedding.

```typescript
// Exported builder (unit-testable — pass a fake env; defaults to process.env).
export function buildSandboxBaseEnv(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	const token = env.GITHUB_TOKEN;
	if (token) {
		out.GITHUB_TOKEN = token;          // for `curl -H "Authorization: Bearer $GITHUB_TOKEN"`
		out.GIT_HTTP_BEARER_TOKEN = token; // for just-git push/clone over HTTP (remote.ts:110)
	}
	// Optional committer-identity passthrough (so `git commit` works out of the box);
	// only injected when the operator sets them on the server env.
	for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const) {
		const v = env[k];
		if (v) out[k] = v;
	}
	return out;
}

// Read once at SessionManager construction (or module load) so it's stable per process:
const sandboxBaseEnv = buildSandboxBaseEnv();

// in new Bash({...}) — add:
env: Object.keys(sandboxBaseEnv).length > 0 ? { ...sandboxBaseEnv } : undefined,
```

Notes:
- **Per-request override is automatic** — `bash.exec({ env })` merges over this base (`Bash.ts:249`), so a caller passing `GITHUB_TOKEN`/`GIT_HTTP_BEARER_TOKEN` in `body.env` wins for that exec.
- **Does not require `network:true`** to be *present* in env, but is only *useful* when network is on (token is inert without outbound). Injecting it unconditionally is fine and keeps the env stable across runtime flags.
- **No new dependency on git** — this base-env path also benefits `curl`/`js-exec`; it's logically independent but shares the same `new Bash` edit.
- Pass a shallow copy (`{ ...SANDBOX_BASE_ENV }`) so just-bash can't mutate the shared const.

### Phase 1: Success Criteria

#### Phase 1: Automated Verification
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint:fix` clean.
- [ ] New unit test passes: `pnpm test -- src/api/tests/unit/git-command.test.ts`.
- [ ] `pnpm test:unit` (full unit suite) passes.

#### Phase 1: Manual Verification
- [ ] In a `network:false` sandbox: `git init && echo hi > a.txt && git add . && GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@x.com GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@x.com git commit -m init && git log --oneline` succeeds.
- [ ] In a `network:false` sandbox: `git clone https://github.com/x/y` fails cleanly (no crash, non-zero exit, sanitized message) — local ops unaffected.
- [ ] With server `GITHUB_TOKEN` set: `echo $GITHUB_TOKEN` in a new sandbox prints the token; with it unset, prints empty (no `GITHUB_TOKEN`/`GIT_HTTP_BEARER_TOKEN` keys in env).
- [ ] A per-request `env: { GITHUB_TOKEN: "override" }` shadows the server default for that exec only.

### Phase 1: Discoveries and Notable Information
[Filled by the implementing agent during Phase 1 execution.]

---

## Phase 2: Expose `network` in MCP + correct stale docs

### Phase 2: Overview
Let MCP-created sandboxes opt into network, and fix comments/descriptions that wrongly claim no network/curl.

### Phase 2: Changes Required

#### 1. MCP `sandbox_create` network option
**File**: `src/api/mcp/tools.ts` (`:32-56`)
**Changes**: add `network: z.boolean().optional()` to the tool's input schema (with a `.describe(...)`), read `args.network ?? false` into `runtimeOptions.network`, keep passing it to `persistSandboxMeta`, and include `network` in the returned JSON (parity with the HTTP route `sandboxes.ts:134`).

```typescript
{
	name: z.string().max(255).optional().describe("Human-readable name for the sandbox"),
	python: z.boolean().optional(),
	javascript: z.boolean().optional(),
	network: z.boolean().optional().describe("Grant outbound HTTPS (enables curl + git clone/fetch/push)"),
},
// ...
const runtimeOptions = {
	python: args.python ?? false,
	javascript: args.javascript ?? false,
	network: args.network ?? false,
};
// ...return text JSON includes network: runtimeOptions.network
```

#### 2. Correct stale capability descriptions
**File**: `src/api/mcp/tools.ts` (`:170-179`)
**Changes**: the bash-tool capability text says "no network", "no curl/wget", "network access of any kind" not supported. Update to state that **when the sandbox is created with `network:true`**, `curl` and outbound `git clone/fetch/push` are available (still no apt/pip/npm/compilers). Keep the air-gapped wording scoped to `network:false`.

**File**: `src/api/session-manager.ts` (`:562-565`)
**Changes**: rewrite the comment so it no longer claims bash is air-gapped with "no curl/wget/DNS" when network is on. Describe reality: `network:true` registers just-bash's `curl` (via `secureFetch`) and enables git's outbound transport (via `globalThis.fetch`).

#### 3. OpenAPI spec (only if missing)
**File**: `src/api/openapi-spec.ts`
**Changes**: confirm the `POST /v1/sandboxes` request body and sandbox response schemas document `network: boolean` alongside `python`/`javascript` (`:321-322`, `:23-24`). If absent, add it. (Do not bump `info.version` — that is the release workflow's job.)

#### 4. Document `GITHUB_TOKEN` (and identity passthrough) in the env-var table
**File**: `CLAUDE.md` (Environment Variables table) and `.env.example` (if present)
**Changes**: add a `GITHUB_TOKEN` row — "Optional. When set, exported into every sandbox's shell env as `GITHUB_TOKEN` (for `curl` GitHub API) and `GIT_HTTP_BEARER_TOKEN` (for `git push/clone`). Shared, deployment-wide identity; readable by sandbox code — use only with trusted agents. Per-request `env` overrides it." Document the optional `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` passthrough. Add `GITHUB_TOKEN=` to `.env.example` with a comment.

### Phase 2: Success Criteria

#### Phase 2: Automated Verification
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint:fix` clean.
- [ ] `pnpm test:unit` passes (incl. any MCP tool tests).

#### Phase 2: Manual Verification
- [ ] MCP `sandbox_create` with `{ network: true }` yields a sandbox where `curl https://api.github.com/zen` and `git clone` work.
- [ ] MCP `sandbox_create` with no `network` (or `false`) still blocks outbound (curl unavailable, clone fails cleanly).
- [ ] Tool descriptions read correctly for both network states.

### Phase 2: Discoveries and Notable Information
[Filled by the implementing agent during Phase 2 execution.]

---

## Phase 3: Network/credentials integration test + changeset

### Phase 3: Overview
Prove the end-to-end network path (clone → commit → push with env-supplied identity/token) hermetically, and record the change.

### Phase 3: Changes Required

#### 1. Integration test (hermetic, in-process remote)
**File**: `src/api/tests/integration/git-network.integration.test.ts` (new)
**Changes**: stand up just-git's in-memory server (`createServer` from `just-git/server`) as the remote, and route the sandbox git instance's `network.fetch` to `server.fetch` for the test (test-only `createGit({ network: { fetch } })`). Verify, through `bash.exec`:
- `git clone <in-proc-url> /repo` populates files.
- a commit using `GIT_AUTHOR_*`/`GIT_COMMITTER_*` from the exec `env` records the expected author/committer.
- `GIT_HTTP_BEARER_TOKEN` from `env` is accepted by a token-gated `preReceive` hook on the server; an absent/wrong token is rejected.
- `git push` updates the server ref.

Gate with `describe.skipIf(...)` only if the in-memory-server harness proves heavy; otherwise it runs with the unit suite (no external network, no DB). Follow the `tests/` conventions in CLAUDE.md (≤300 lines, cleanup in `afterEach`).

For the bearer-token leg, set the server token via the test's `process.env.GITHUB_TOKEN` (or construct the session manager with it) and assert the in-process server's `preReceive` sees `Authorization: Bearer <token>` — proving the injected `GIT_HTTP_BEARER_TOKEN` reaches the transport without per-request creds.

#### 2. Env-injection unit test
**File**: `src/api/tests/unit/sandbox-base-env.test.ts` (new)
**Changes**: with `GITHUB_TOKEN` set, a new session's `bash.exec("echo \"$GITHUB_TOKEN:$GIT_HTTP_BEARER_TOKEN\"")` prints the token twice; with it unset, prints `:` (both empty). A per-request `env` override shadows the base for that call only. (Module-level `SANDBOX_BASE_ENV` reads `process.env` at load — structure the helper so the test can inject config, e.g. a tiny exported `buildSandboxBaseEnv(env = process.env)` builder rather than a frozen const, to keep it unit-testable.)

#### 3. Changeset
**File**: `.changeset/*.md` (new, via `pnpm changeset`)
**Changes**: minor bump; describe "Add `git` command to sandboxes (just-git); export server `GITHUB_TOKEN` into sandbox env; MCP `sandbox_create` accepts `network`."

### Phase 3: Success Criteria

#### Phase 3: Automated Verification
- [ ] `pnpm test -- src/api/tests/integration/git-network.integration.test.ts` passes.
- [ ] `pnpm typecheck && pnpm lint:fix && pnpm test:unit` all pass.
- [ ] A `.changeset/*.md` file exists and describes the change.

#### Phase 3: Manual Verification
- [ ] Against a real remote (e.g. a throwaway GitHub repo, `network:true`): clone → edit → commit (identity via `env`) → push (token via `GIT_HTTP_BEARER_TOKEN`) → confirm the commit lands on GitHub.

### Phase 3: Discoveries and Notable Information
[Filled by the implementing agent during Phase 3 execution.]

---

## Testing Strategy

### Unit Tests
- git command is present in a freshly built session's command set.
- Local lifecycle through `bash.exec`: `init → add → commit → log/status/diff` (no network).
- `network:false` ⇒ `git clone` exits non-zero with a sanitized message; local ops still succeed.
- Committer identity is taken from exec `env` (`GIT_AUTHOR_*`/`GIT_COMMITTER_*`).

### Integration Tests
- Hermetic clone/commit/push against an in-process just-git server (Phase 3), incl. token gating via `GIT_HTTP_BEARER_TOKEN`.

### Manual Testing Steps
1. Create a `network:true` sandbox (HTTP and MCP). 2. `curl https://api.github.com/zen`. 3. `git clone` a public repo. 4. Edit + commit with identity env. 5. `git push` to a writable repo with a token env. 6. Create a `network:false` sandbox and confirm curl is absent and clone fails cleanly while local git works.

## Performance Considerations

- `createGit()` is called once per session build (alongside `new Bash`), negligible cost. git operates on the same `IFileSystem` (SqlFs) — object/pack writes become blob/inode writes through the existing cache + transaction path; large clones produce many writes, bounded by existing session/exec limits. No new hot loop in the request path.
- `trusted: true` means git runs outside the defense-in-depth patched scope — no added per-call patch/unpatch beyond what just-bash already does for trusted commands.

## Migration Notes

- No schema or data migration. Existing sandboxes gain `git` on their next session build (sessions are warm, in-memory; eviction/rebuild picks it up).
- `network` semantics are unchanged for existing sandboxes; only the MCP create path gains the option.
- Rollback = remove `gitCommand` from `customCommands` and drop the dependency; no persisted state depends on git.

## Security / Operational Assumptions

These follow from the two decisions (export-into-env · single deployment-wide token) and MUST hold for this design to be safe:

- **Trusted agents only.** With full outbound and `GITHUB_TOKEN` readable in the sandbox (`echo $GITHUB_TOKEN`), any code running in a sandbox can exfiltrate the token to an arbitrary host. Acceptable only if the agents/scripts driving sandboxes are trusted. Untrusted/user-submitted scripts would require the deferred hardened posture (egress header-injection + allowlist).
- **Single-tenant identity.** The one `GITHUB_TOKEN` is a shared GitHub identity across every sandbox/tenant. Scope the token's GitHub permissions to the minimum needed (e.g. a fine-grained PAT limited to the target repos, `contents:write` + `pull_requests:write` + `issues:write`). Do not use a broad classic PAT.
- **Token never persisted.** It lives only in server `process.env`; it is not written to `sandboxes` meta or any table, and must not be echoed into structured logs (avoid logging sandbox env / `body.env`).
- **Rotation = redeploy.** Because the value is read at process start, rotating the token means updating `.env` and restarting/redeploying replicas. Warm sessions created before a rotation keep the old token until evicted/rebuilt.
- **Revisit on multi-tenancy.** If this deployment ever serves distinct customers, this plan's token model must change (per-tenant resolution or per-request-only) before that rollout.

## References

- Trace-analysis harness (motivation): `/Users/nguyendangquang/master/Web-Dev/just-bash/thoughts/trace-analysis-agent-harness.md`
- just-git client docs: `https://github.com/blindmansion/just-git` (`docs/CLIENT.md`)
- Integration point: `src/api/session-manager.ts:549-568`
- Existing custom-command pattern: `src/api/commands/node-command.ts`
- MCP create tool: `src/api/mcp/tools.ts:32-56`
- HTTP create route (network already wired): `src/api/routes/sandboxes.ts:22,52,109,130,134`
- Defense-in-depth helper (pattern reference, not needed for git): `src/sql-fs/defense.ts`
- just-git registration/network facts: `git.ts:489`, `custom-commands.ts:48`, `types.ts:238-247`, `remote.ts:88-115`, `identity.ts:7-65`
