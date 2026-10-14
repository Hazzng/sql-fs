# Security

Use the repository's [security page](https://github.com/Hazzng/sql-fs/security) to check the available private reporting channel.
Private vulnerability reporting was disabled at the October 2026 readiness audit. Until the maintainer enables it, open a public issue requesting a private contact without disclosing the vulnerability.
Include the affected revision, a minimal reproduction, and the expected isolation or authorization behavior.
Do not include live tokens, database connection strings, or customer data in public issues.

Run `pnpm security:audit` to check production Node dependencies for high and critical advisories.
The security workflow audits locked Python runtime dependencies and configures CodeQL for TypeScript and Python. Dependabot proposes dependency updates weekly after its configuration reaches the default branch.
The patched `just-bash` dependency needs manual upgrades and its runtime regression tests.

The separate all-dependency audit (`pnpm audit --audit-level=high`) also includes development tools. On 2026-10-13, `pnpm audit --json` at `eeaf7a6` reported 15 high and three critical advisory entries, including Vitest and Tinypool. The [committed audit snapshot](security/audits/node-2026-10-13.json) records the command, tool versions, lockfile hash, severity counts, advisory IDs, and dependency paths. No entries in that snapshot were reachable through the root `ajv` or `ajv-formats` dependencies used by the OpenAPI validator. This is a dated observation; rerun the audit after dependency or advisory-database changes. The development advisories remain an outstanding maintenance task outside the production-only CI gate. A passing production audit does not establish that the development toolchain is free of advisories.

Two targeted overrides in `pnpm-workspace.yaml` replace vulnerable exact pins in `guarded-fetch` and `express-rate-limit`. Remove an override when its parent dependency selects a fixed version, then rerun the audit and runtime verification.

The October 2026 audit retains [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), a moderate precision-formatting exception in `sprintf-js` with no published fixed version. Local probes of the installed runtime returned command errors for `printf '%.101f' 1` and the equivalent `awk` call, then executed another command successfully. This does not prove every format path is unaffected. The advisory remains visible in `pnpm audit`; the high-severity gate does not suppress it.

Python 3.9 resolves `anyio==4.12.1`, which retains [GHSA-82r6-8w77-94w6](https://github.com/advisories/GHSA-82r6-8w77-94w6) and [GHSA-5p39-cfhj-2xmp](https://github.com/advisories/GHSA-5p39-cfhj-2xmp). The fixed AnyIO release requires Python 3.10 or later. The SDK currently uses synchronous `httpx.Client`; that does not establish that every application using its dependency environment is unaffected. Use the documented Python 3.12 development environment for the patched resolution. Python 3.9 compatibility remains covered by tests; removing that support is a separate compatibility decision. The CI dependency audit runs on Python 3.12.

The Postgres application role must not be a superuser or have `BYPASSRLS`.
Use separate Redis instances for control locks and blob data when cache pressure must not evict locks.
See [the runtime settings](README.md#environment-variables) and [the concurrency model](docs/DEVELOPER.md).
