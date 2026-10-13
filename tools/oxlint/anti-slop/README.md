# Vendored anti-slop rules

Source: https://github.com/dmmulroy/anti-slop
Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
License: MIT (see LICENSE).

The generic `src/index.ts`, `src/rules/*.ts`, `src/shared/*.ts`, and their `src/vendor/` dependencies are copied verbatim, excluding upstream tests. The nested ESLint Stylistic dependency retains its own license and provenance. Effect rules are not included because this repository does not use Effect. The install skill's bundled copy was compared with this revision and updated before configuration. When updating, compare source changes and retain the local policy in `.oxlintrc.json`; do not automatically enable new rules. Oxlint and `@oxlint/plugins` must use the same exact version.

## Local policy

Biome retains formatting, imports, and existing lint coverage. `.oxlintrc.json` enables Oxlint's native correctness category at error severity, plus `eslint/array-callback-return` and these five safeguards:

- `anti-slop/no-chained-type-assertions`: do not discard type evidence with repeated casts.
- `anti-slop/no-object-parameters`: accept a useful domain type instead of `object`.
- `anti-slop/no-widen-then-assert`: do not erase a known type and then assert it back.
- `anti-slop/no-reduce-accumulator-copy`: avoid repeatedly copying a growing accumulator.
- `oxc/no-accumulating-spread`: catch the native spread variant of accumulator copying.

The first two apply to production code, scripts, and SDK examples. Test files and `tests/` fixtures may cast incomplete doubles and use opaque object identities; they still receive the other three rules and Biome checks. This is a deliberate fixture policy, not a claim that existing test casts are type-safe.

We do not enable the blanket bans on `unknown`, runtime narrowing, dictionaries, or module mocks: boundary parsing and transport tests use these intentionally. `no-known-value-widening` also flags deliberate `unknown` error storage. Naming, conditional-spread, filter/map, spacing, and mandatory assertion-comment policies are not adopted in this initial configuration. No Effect rules are registered. Oxlint's native correctness baseline now complements Biome, including scripts excluded from Biome.

`.oxlintrc-type-aware.json` extends the syntax policy and selects four type-aware errors: `typescript/no-floating-promises`, `typescript/no-misused-promises`, `typescript/await-thenable`, and `typescript/no-misused-spread`. It also enables `vitest/no-focused-tests`, `vitest/no-disabled-tests`, `vitest/valid-describe-callback`, and `vitest/require-awaited-expect-poll`. Type-aware checks scan `src` and the TypeScript SDK; scripts receive the syntax checks. We select these rules rather than enabling every optional Vitest or typed correctness rule.

`vitest/valid-expect` and `vitest/valid-expect-in-promise` are not enabled: they flag assertions attached before a concurrency barrier and awaited afterward. This pattern prevents an injected failure from becoming an unhandled rejection. The type-aware promise checks allow it and reject dropped promise assertions; CLI fixtures prove the supported pattern. Ordinary Vitest assertion messages are also valid. We do not rewrite these tests to await before releasing a barrier.

TypeScript is pinned to 7.0.2 in both package lockfiles; `oxlint-tsgolint` is pinned to 7.0.2004. The architecture checker uses TypeScript 7's `unstable/sync` and `unstable/ast` APIs, follows native resolved symbols, scans production source even when excluded by tsconfig, and closes its compiler session. Its negative fixtures must keep passing when upgrading TypeScript. Driver-fault guard tests use `tsx` and real child processes.

`pnpm lint:oxlint` runs syntax and type-aware checks and loads vendored TypeScript through the existing `tsx` dependency for Node 22 compatibility. `pnpm lint` runs both tools; `pnpm lint:fix` formats with Biome and then checks Oxlint. Vendored sources are excluded from both tools so updates preserve upstream code. `scripts/oxlint-policy.test.mjs` exercises the actual CLI against rejected code, accepted boundary parsing, and fixture exceptions.
