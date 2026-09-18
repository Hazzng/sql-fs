/**
 * Package-manifest format version.
 *
 * Lives in the sql-fs layer (next to `package-path.ts`) rather than in
 * `src/api/commands/package-limits.ts` because it describes a stored database
 * row, is read and written by the dialect, and the dialect cannot import from
 * `src/api` without inverting the layering (api → sql-fs).
 *
 * Bump whenever extraction rules, path spreading, mode normalisation or the
 * compat overlay change. `lookupManifest` matches on
 * `(wheel_sha256, manifest_format)`, so a row written by an older format reads
 * as a miss and is replaced by the next install of that wheel.
 */
export const MANIFEST_FORMAT = 1;
