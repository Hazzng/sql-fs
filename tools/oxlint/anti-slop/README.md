# Vendored anti-slop rules

Source: https://github.com/dmmulroy/anti-slop
Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
License: MIT (see LICENSE).

The generic `src/index.ts`, `src/rules/*.ts`, `src/shared/*.ts`, and their `src/vendor/` dependencies are copied verbatim, excluding upstream tests. The nested ESLint Stylistic dependency retains its own license and provenance. Effect rules are not included because this repository does not use Effect. The install skill's bundled copy was compared with this revision and updated before configuration. When updating, compare source changes and retain the local policy in `.oxlintrc.json`; do not automatically enable new rules. Oxlint and `@oxlint/plugins` must use the same exact version.

## Local policy

Biome retains formatting, imports, and existing lint coverage. Oxlint adds five error-level rules:

- `anti-slop/no-chained-type-assertions`: do not discard type evidence with repeated casts.
- `anti-slop/no-object-parameters`: accept a useful domain type instead of `object`.
- `anti-slop/no-widen-then-assert`: do not erase a known type and then assert it back.
- `anti-slop/no-reduce-accumulator-copy`: avoid repeatedly copying a growing accumulator.
- `oxc/no-accumulating-spread`: catch the native spread variant of accumulator copying.

The first two apply to production code, scripts, and SDK examples. Test files and `tests/` fixtures may cast incomplete doubles and use opaque object identities; they still receive the other three rules and Biome checks. This is a deliberate fixture policy, not a claim that existing test casts are type-safe.

We do not enable the blanket bans on `unknown`, runtime narrowing, dictionaries, or module mocks: boundary parsing and transport tests use these intentionally. `no-known-value-widening` also flags deliberate `unknown` error storage. Naming, conditional-spread, filter/map, spacing, and mandatory assertion-comment policies are not adopted in this initial configuration. No Effect rules are registered. Oxlint's default correctness category is off because Biome continues to own that coverage; selected Oxlint rules are explicitly errors.

`pnpm lint:oxlint` loads vendored TypeScript through the existing `tsx` dependency for Node 22 compatibility. `pnpm lint` runs both tools; `pnpm lint:fix` formats with Biome and then checks Oxlint. Vendored sources are excluded from both tools so updates preserve upstream code. `scripts/oxlint-policy.test.mjs` exercises the actual CLI against rejected code, accepted boundary parsing, and fixture exceptions.
