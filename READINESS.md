# Agent readiness

This audit uses the eight areas in [Factory's Agent Readiness article](https://factory.com/news/agent-readiness). It checks the actual development workflow, not a Factory score. No official Factory report or maturity level was generated.

## Implementation workflow

The entry point is [AGENTS.md](AGENTS.md). Run `pnpm setup:dev`, `pnpm check`, and `pnpm verify:local`. The first command installs locked dependencies. The second covers the server and both SDKs without services. The third exercises real Postgres, Redis, HTTP, MCP, and SDK behavior in a disposable stack. Use `pnpm verify:architecture` for ownership or protocol changes; CI runs that expanded profile, including worker failures, SSE finalization, input budgets, and tenant isolation.

| Area | Repository evidence | Remaining limit |
| --- | --- | --- |
| Style and validation | Strict TypeScript, Biome, Python Ruff and mypy, Lefthook checks, `pnpm check` | Hooks require the development dependencies installed by setup. |
| Build system | Node version file, pinned pnpm, three lockfiles, server and SDK builds | Dependencies and container images need network access on first use. |
| Testing | Unit suites, serial database integration suite, live HTTP/MCP and SDK verification, JSON proof artifacts | Specialized resource profiles and deployment load tests remain separate from the default verification run. |
| Documentation | Shared `AGENTS.md`, Claude pointer, setup guide, current architecture paths, explicit migration instructions | Historical records under `thoughts/shared/` can describe older designs. |
| Development environment | Disposable Compose project, random loopback ports, separate Redis roles, clean child environment, scoped cleanup | Requires Docker and Compose v2, Bash, Node, Python, pnpm, and uv. |
| Code quality | Type and lint checks, production ownership boundary checks, bounded test concurrency, explicit test-runner ownership, removed unused drivers and stale schema tooling | Static rules do not replace review or live behavior tests. |
| Observability | `/healthz`, `/readyz`, authenticated `/metrics`, structured logs, request traces and artifact hashes in verification proof | Production alert routing and dashboards are deployment configuration. |
| Security and governance | Dependency audit workflow, CodeQL workflow, Dependabot, CODEOWNERS, `SECURITY.md`, isolation tests | Hosted readiness checks passed on PR #238 at `eeaf7a6`, including the expanded architecture profile. Main now requires 12 Actions checks and an up-to-date branch; existing administrator bypass remains enabled. |

## Verification record

The October 2026 local audit starts from revision `58a8fc2`. Evidence for the session is in `.audit/agent-readiness.tsv` and its referenced command logs. API runs print an evidence directory under `scripts/verify/.run/`; each contains `proof.json`, request logs, and server logs. The integration runner also emits `integration.json` and rejects skipped tests.

The original unit run exposed a scheduling race in a child-process fixture and CPU contention in a large WASM test. The fixture now starts its sentinel only after dispatching the exception callback, and Vitest uses two workers. Node-native script tests and SDK tests have separate runners. A database test misplaced under `unit` moved to `integration` so the disposable database run selects it. The tenant-concurrency test now proves overlap with a barrier and cleans up even on failure. Quota fixtures retain their capacity assertions with longer queue waits. The large-file integration fixture supplies a declared resource profile; production host-admission behavior remains covered separately by resource-policy tests.

The corrected live run passed 258 integration tests across 40 files with no skipped tests, 92 HTTP/MCP checks, and 90 live SDK checks. All API proof records confirm that owned servers stopped and sandbox cleanup completed. The credential-free suites passed 2,198 core tests, 148 TypeScript SDK tests, 174 Python SDK tests, and nine script tests. A separate Python 3.9 compatibility run passed all 174 SDK tests. Fresh-checkout SDK installation, workflow syntax checks, and commit-hook invocation also passed.

The Docker image built and passed a separate HTTP smoke test covering readiness, authentication, sandbox execution, persisted file reads, metrics, and deletion. The optional container resource profiler could not run on this host because it requires cgroup v2 files. No container performance or large-file deployment capacity claim is made from that failed profiling attempt.

## Guardrails follow-up

`pnpm check` includes the production ownership checker and its negative-control fixtures. Named worker adapters, central script completion, and neutral cancellation context give agents enforced extension points. The checker rejects common alternate import and indirect scope-call forms; it does not perform whole-program dataflow analysis.

The HTTP and SDK harnesses validate observed `/v1` operations, status codes, media types, and JSON bodies against the served OpenAPI document. SDK proof records include per-language exchange and schema-validation counts. Binary file contents remain opaque regardless of filename extension. Python streaming stays under the SDK's control. Query/header/path parameter schemas and SSE event schemas are outside this validator's coverage; their existing behavior assertions still run.

The combined architecture and guardrails run passed `pnpm check` with 2,283 core tests, 28 script tests, 148 TypeScript SDK tests, and 174 Python SDK tests. Python 3.9 type checking also passed. `pnpm verify:architecture` passed 258 integration tests with no skips, 92 HTTP/MCP checks, 99 live SDK checks, 110 worker-failure checks, 109 SSE-finalization checks, 283 input-budget checks, and 27 tenant checks. All six API proofs confirm sandbox cleanup and stopped owned servers. The run is `scripts/verify/.run/verify-1791868820-1394395`; the delivery audit is `.audit/agent-guardrails-20261013/`.

## Hosted follow-up

These facts came from read-only GitHub API checks during the audit. Local files cannot enforce them.

- `main` requires one approving review, an up-to-date branch, and 12 checks from the GitHub Actions app: `Lint & Typecheck`, `Unit Tests`, `TypeScript SDK`, `Build`, `Integration & API`, `Lint & Format`, `Type Check`, `Test (Python 3.9)`, `Test (Python 3.11)`, `Test (Python 3.13)`, `Dependency audit`, and `CodeQL`. These contexts passed on PR #238 at `82ba380` on 2026-10-13. The [Integration & API job](https://github.com/Hazzng/sql-fs/actions/runs/38361832506/job/115177598836) ran `pnpm verify:architecture`, including the worker, architecture, and review fixes. This is an immutable verification record; require a fresh successful run for every subsequent PR head. Existing administrator bypass is unchanged. The guardrails follow-up read back the exact check names and app binding from GitHub.
- Secret scanning and secret push protection are enabled.
- Private vulnerability reporting is disabled. A maintainer can enable it in the repository security settings.
- The advanced CodeQL workflow passed on PR #238.
- Dependabot security updates are disabled in repository settings. This change supplies scheduled version-update configuration.

Workflow files alone are not proof of hosted enforcement. The original audit left repository settings unchanged; the authorized guardrails follow-up enabled required status checks and verified the settings through the GitHub API. No deployment, release, or merge was performed.

## Known dependency advisory

The production Node audit retains one moderate `sprintf-js` advisory with no published fixed version. High and critical advisories were removed through dependency updates, removal of unused drivers, and two scoped transitive overrides. The Python lock update removes the advisories for the documented Python 3.12 environment. The Python 3.9 resolution retains two AnyIO advisories because the fixed package requires Python 3.10 or later. The broader development-tool audit still reports high and critical advisories outside the production gate. See [SECURITY.md](SECURITY.md) for these limits and the observed runtime behavior.
