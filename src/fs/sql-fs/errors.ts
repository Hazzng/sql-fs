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
