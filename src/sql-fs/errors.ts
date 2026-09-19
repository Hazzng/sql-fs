/**
 * FS error constructors and SQL error translation.
 * US-003: FS error constructors and SQL error translation
 */

type FsError = Error & { code: string; path?: string };

function makeFsError(code: string, message: string, path?: string): FsError {
	const err = Object.assign(new Error(message), { code, ...(path !== undefined && { path }) });
	return err;
}

/** ENOENT: no such file or directory */
export function createEnoent(path: string): Error {
	return makeFsError("ENOENT", `ENOENT: no such file or directory, '${path}'`, path);
}

/** EEXIST: file already exists */
export function createEexist(path: string): Error {
	return makeFsError("EEXIST", `EEXIST: file already exists, '${path}'`, path);
}

/** EISDIR: illegal operation on a directory */
export function createEisdir(path: string): Error {
	return makeFsError("EISDIR", `EISDIR: illegal operation on a directory, '${path}'`, path);
}

/** ENOTDIR: not a directory */
export function createEnotdir(path: string): Error {
	return makeFsError("ENOTDIR", `ENOTDIR: not a directory, '${path}'`, path);
}

/** ENOTEMPTY: directory not empty */
export function createEnotempty(path: string): Error {
	return makeFsError("ENOTEMPTY", `ENOTEMPTY: directory not empty, '${path}'`, path);
}

/** ELOOP: too many levels of symbolic links */
export function createEloop(path: string): Error {
	return makeFsError("ELOOP", `ELOOP: too many levels of symbolic links, '${path}'`, path);
}

/** EPERM: operation not permitted */
export function createEperm(path: string, op: string): Error {
	return makeFsError("EPERM", `EPERM: operation not permitted, ${op} '${path}'`, path);
}

/** EINVAL: invalid argument (e.g. readlink on a non-symlink) */
export function createEinval(path: string): Error {
	return makeFsError("EINVAL", `EINVAL: invalid argument, '${path}'`, path);
}

/**
 * EREADONLY: write attempted while the filesystem is in read-only scope.
 * Surfaced when a `readOnly: true` exec script tries to mutate state. The
 * session-manager wraps the script-level handler so the offending command
 * fails fast and other concurrent readers never observe partial state.
 */
export function createEreadonly(path: string, op: string): Error {
	return makeFsError("EREADONLY", `EREADONLY: read-only filesystem, ${op} '${path}'`, path);
}

/** ESTALE: fencing epoch mismatch — retry with a fresh scope. */
export function createEstale(sandboxId: string): Error {
	return makeFsError("ESTALE", `ESTALE: stale sandbox epoch, '${sandboxId}'`);
}

/**
 * ESANDBOXGONE: the sandbox (or its root inode) no longer exists in the DB.
 *
 * Raised by `SqlFs.#loadFreshPathCache` when `loadAllPaths` returns zero rows —
 * the recursive CTE anchor joins `sandboxes` → root `inodes`, so an empty result
 * means the sandbox/root was destroyed (F7). The caller (`ready`/`reload`) must
 * NOT install an empty pathCache (which would serve ghost ENOENTs for every
 * path); instead the session manager catches this, tears the warm session down,
 * and surfaces a clean ENOENT → 404 to the client. Distinct from ENOENT so the
 * teardown path is unambiguous and never confused with a single missing file.
 */
export function createEsandboxgone(sandboxId: string): Error {
	return makeFsError("ESANDBOXGONE", `ESANDBOXGONE: sandbox no longer exists, '${sandboxId}'`);
}

/**
 * EDRIVERFAULT: the Postgres driver threw out of its own socket-write path while
 * this call was in flight (#169).
 *
 * `postgres.js` nulls a connection's socket in `closed()` and then flushes a
 * still-buffered write for it, throwing a `TypeError` from a bare `setImmediate`
 * rather than rejecting the query it was writing. The query's promise therefore
 * never settles: without this the request hangs until the client gives up, which
 * is what suppressing the crash alone buys you. The process guard converts that
 * into this error instead.
 *
 * NOT advertised retryable. The fault can land on a connection that had already
 * sent its COMMIT, so "nothing was applied" is exactly what we cannot prove —
 * same reasoning as ECOHERENCE. The `cause` carries the driver's own error for
 * the log; the message never reaches a client unsanitized.
 */
export function createEdriverfault(cause: Error): Error {
	const err = makeFsError("EDRIVERFAULT", "EDRIVERFAULT: the database connection failed mid-statement");
	return Object.assign(err, { cause });
}

/**
 * EFBIG: sandbox exec tried to read or produce a file over the per-file ceiling (#168).
 *
 * The message is the recovery path for an autonomous agent — do not retry, both sizes,
 * routes that actually work, operator env var. Avoid `sandboxes`/`/tmp` prefixes;
 * `sanitizeFsError` would redact them. Sibling HTTP/MCP caps are independently
 * configured, so the remedy interpolates their live values rather than hardcoded defaults.
 */
export function createEfbig(path: string, attemptedBytes: number, limitBytes: number, op: "read" | "write"): Error {
	const mcpReadBytes = configuredBytes("MAX_MCP_READ_FILE_BYTES", 16 * 1024 * 1024);
	const fileWriteBytes = configuredBytes("MAX_FILE_WRITE_BYTES", 50 * 1024 * 1024);
	const preamble =
		op === "read" ? `'${path}' is ${attemptedBytes} bytes` : `writing '${path}' would produce ${attemptedBytes} bytes`;
	const remedy =
		op === "read"
			? `fetch it over HTTP with \`GET .../files/{path}\`, the one read path this limit does not apply to; MCP \`file_read\` is capped separately at ${mcpReadBytes} bytes (\`MAX_MCP_READ_FILE_BYTES\`). Slicing it in the sandbox does NOT help: \`head -c\`, \`tail -c\`, \`split -b\` and \`sed -n\` all read the whole file through the same call and re-trip this same limit`
			: `write several smaller files (\`split -b\`, reading from a pipe rather than the oversized file), send large content in over HTTP with \`PUT .../files/{path}\` (MCP \`file_write\`), or change part of a file with \`PATCH .../files/{path}\` (MCP \`file_edit\`) instead of rewriting it whole. Those routes are capped independently at ${fileWriteBytes} bytes (\`MAX_FILE_WRITE_BYTES\`)`;
	return makeFsError(
		"EFBIG",
		[
			`EFBIG: file too large for sandbox exec, ${preamble} and the per-file exec limit is ${limitBytes} bytes.`,
			`This is a deliberate limit, not a transient failure — the same command will fail again, so split the work instead of retrying it: ${remedy}.`,
			"Operators raise the ceiling with the MAX_EXEC_FILE_BYTES environment variable.",
		].join(" "),
		path,
	);
}

/** Same parse as `positiveIntEnv`. Local — importing `api/lib/env` would cycle through `sql-fs.ts`. */
function configuredBytes(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * ENOBUFS: a script buffered more metadata mutations than the flush budget allows (#166).
 *
 * Under the buffered script-tx a script's mutations are held in memory and replayed
 * in one short transaction at scope end, so the buffer is the only thing standing
 * between an unbounded `for` loop in bash and an unbounded heap. At the cap the
 * script fails and **nothing is applied** — the buffer is discarded without a
 * transaction ever opening. Auto-flushing instead would silently convert the scope
 * into two commits and break the per-script all-or-nothing guarantee that
 * `ELOCKLOST`'s "not committed" claim rests on.
 *
 * Known-not-applied, but deliberately NOT advertised `retryable`: the repo defines
 * that flag as "applied nothing AND the condition is transient", and an identical
 * re-run hits the identical cap. The remedy is to split the script, which the
 * message says.
 */
export function createEnobufs(ops: number, bytes: number, maxOps: number, maxBytes: number): Error {
	return makeFsError(
		"ENOBUFS",
		[
			`ENOBUFS: too many filesystem changes in one script — ${ops} operations / ${bytes} bytes buffered`,
			`against a limit of ${maxOps} operations / ${maxBytes} bytes.`,
			"Nothing was applied: the whole script was rolled back before any of it reached the database.",
			"This is a deliberate limit, not a transient failure — split the work across several exec calls",
			"(or use the bulk ingest route for large file sets) rather than retrying the same script.",
			"Operators raise the ceiling with SCRIPT_TX_BUFFER_MAX_OPS / SCRIPT_TX_BUFFER_MAX_BYTES.",
		].join(" "),
	);
}

// ── Sensitive-pattern stripping ───────────────────────────────────────────────

/** Patterns whose matches are replaced with [redacted] in sanitized error messages. */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
	// Connection string URLs: postgres://, postgresql://, mysql://, mssql://, etc.
	/(postgres(?:ql)?|mysql|mssql|sqlserver):\/\/[^\s"')]+/gi,
	// T-SQL ADO.NET-style connection strings: Server=...; Database=...; etc.
	/(?:Server|Data Source|Initial Catalog|User Id|Password)=[^;]+;?/gi,
	// Internal table names
	/\b(sandboxes|inodes|dirents|blobs)\b/g,
	// Host absolute paths (at least 3 segments to avoid stripping FS paths like /home/user)
	// Includes /Users for macOS
	/\/(?:var|usr|opt|home|root|etc|tmp|proc|run|lib|lib64|sys|dev|Users)(?:\/[^\s"')]+){1,}/g,
];

/**
 * Strips connection strings, host paths, and internal table names from error
 * messages so that raw SQL errors cannot leak sensitive infrastructure details
 * into API responses.
 */
export function sanitizeFsError(err: Error): Error {
	let message = err.message;
	for (const pattern of SENSITIVE_PATTERNS) {
		message = message.replace(pattern, "[redacted]");
	}
	if (message === err.message) return err;
	return Object.assign(new Error(message), { code: (err as FsError).code, path: (err as FsError).path });
}

// ── SQL error translation ─────────────────────────────────────────────────────

/**
 * Translates a raw SQL driver error into the appropriate FS error.
 *
 * Supports:
 * - Postgres SQLSTATE codes (err.code string)
 * - MySQL error numbers (err.errno number)
 * - T-SQL / Azure SQL error numbers (err.number number)
 *
 * If the error does not match any known pattern the original error is
 * sanitized and returned so that sensitive details never bubble up.
 */
export function translateSqlError(err: unknown, path: string): Error {
	if (!(err instanceof Error)) {
		return sanitizeFsError(new Error(String(err)));
	}

	const e = err as Error & { code?: unknown; errno?: unknown; number?: unknown };

	// Postgres SQLSTATE codes (string)
	if (typeof e.code === "string") {
		switch (e.code) {
			case "23505": // unique_violation
				return createEexist(path);
			case "FS001": // custom ELOOP from fs_resolve proc
				return createEloop(path);
			case "FS002": // custom ENOENT from fs_resolve proc
				return createEnoent(path);
			case "FS003": // custom ENOTDIR from fs_resolve proc
				return createEnotdir(path);
		}
	}

	// MySQL error numbers (errno property is a number)
	if (typeof e.errno === "number") {
		if (e.errno === 1062) {
			// ER_DUP_ENTRY
			return createEexist(path);
		}
	}

	// T-SQL / Azure SQL error numbers (number property)
	if (typeof e.number === "number") {
		if (e.number === 2601 || e.number === 2627) {
			// Unique index / constraint violation
			return createEexist(path);
		}
	}

	return sanitizeFsError(err);
}
