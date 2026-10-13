# Agent readiness

This audit uses the eight areas in [Factory's Agent Readiness article](https://factory.com/news/agent-readiness). It checks the actual development workflow, not a Factory score. No official Factory report or maturity level was generated.

## Implementation workflow

The entry point is [AGENTS.md](AGENTS.md). Run `pnpm setup:dev`, `pnpm check`, and `pnpm verify:local`. The first command installs locked dependencies. The second covers the server and both SDKs without services. The third exercises real Postgres, Redis, HTTP, MCP, and SDK behavior in a disposable stack.

| Area | Repository evidence | Remaining limit |
| --- | --- | --- |
| Style and validation | Strict TypeScript, Biome, Python Ruff and mypy, Lefthook checks, `pnpm check` | Hooks require the development dependencies installed by setup. |
| Build system | Node version file, pinned pnpm, three lockfiles, server and SDK builds | Dependencies and container images need network access on first use. |
| Testing | Unit suites, serial database integration suite, live HTTP/MCP and SDK verification, JSON proof artifacts | Specialized resource profiles and deployment load tests remain separate from the default verification run. |
| Documentation | Shared `AGENTS.md`, Claude pointer, setup guide, current architecture paths, explicit migration instructions | Historical records under `thoughts/shared/` can describe older designs. |
| Development environment | Disposable Compose project, random loopback ports, separate Redis roles, clean child environment, scoped cleanup | Requires Docker and Compose v2, Bash, Node, Python, pnpm, and uv. |
| Code quality | Type and lint checks, bounded test concurrency, explicit test-runner ownership, removed unused drivers and stale schema tooling | The audit does not establish correctness of every implementation path. |
| Observability | `/healthz`, `/readyz`, authenticated `/metrics`, structured logs, request traces and artifact hashes in verification proof | Production alert routing and dashboards are deployment configuration. |
| Security and governance | Dependency audit workflow, CodeQL workflow, Dependabot, CODEOWNERS, `SECURITY.md`, isolation tests | Hosted checks need a push and successful run. Branch protection does not yet require status checks. |

## Verification record

The October 2026 local audit starts from revision `58a8fc2`. Evidence for the session is in `.audit/agent-readiness.tsv` and its referenced command logs. API runs print an evidence directory under `scripts/verify/.run/`; each contains `proof.json`, request logs, and server logs. The integration runner also emits `integration.json` and rejects skipped tests.

The original unit run exposed a scheduling race in a child-process fixture and CPU contention in a large WASM test. The fixture now starts its sentinel only after dispatching the exception callback, and Vitest uses two workers. Node-native script tests and SDK tests have separate runners. A database test misplaced under `unit` moved to `integration` so the disposable database run selects it. The tenant-concurrency test now proves overlap with a barrier and cleans up even on failure. Quota fixtures retain their capacity assertions with longer queue waits. The large-file integration fixture supplies a declared resource profile; production host-admission behavior remains covered separately by resource-policy tests.

The corrected live run passed 258 integration tests across 40 files with no skipped tests, 92 HTTP/MCP checks, and 90 live SDK checks. All API proof records confirm that owned servers stopped and sandbox cleanup completed. The credential-free suites passed 2,198 core tests, 148 TypeScript SDK tests, 174 Python SDK tests, and nine script tests. A separate Python 3.9 compatibility run passed all 174 SDK tests. Fresh-checkout SDK installation, workflow syntax checks, and commit-hook invocation also passed.

The Docker image built and passed a separate HTTP smoke test covering readiness, authentication, sandbox execution, persisted file reads, metrics, and deletion. The optional container resource profiler could not run on this host because it requires cgroup v2 files. No container performance or large-file deployment capacity claim is made from that failed profiling attempt.

## Hosted follow-up

These facts came from read-only GitHub API checks during the audit. Local files cannot enforce them.

- `main` requires one approving review but has no required status checks. Configure required checks after the new jobs have run successfully. Relevant jobs include `Lint & Typecheck`, `Unit Tests`, `TypeScript SDK`, `Build`, `Integration & API`, the Python checks, and the security checks.
- Secret scanning and secret push protection are enabled.
- Private vulnerability reporting is disabled. A maintainer can enable it in the repository security settings.
- CodeQL default setup is not configured. This change supplies an advanced workflow, whose hosted execution remains to be verified.
- Dependabot security updates are disabled in repository settings. This change supplies scheduled version-update configuration.

Do not treat these workflow files as proof that GitHub has run or enforced the checks. This work does not deploy, release, merge, or change repository settings.

## Known dependency advisory

The production Node audit retains one moderate `sprintf-js` advisory with no published fixed version. High and critical advisories were removed through dependency updates, removal of unused drivers, and two scoped transitive overrides. The Python lock update removes the advisories for the documented Python 3.12 environment. The Python 3.9 resolution retains two AnyIO advisories because the fixed package requires Python 3.10 or later. See [SECURITY.md](SECURITY.md) for these limits and the observed runtime behavior.
