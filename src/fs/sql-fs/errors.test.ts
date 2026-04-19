/**
 * Unit tests for FS error constructors and SQL error translation.
 * US-003: FS error constructors and SQL error translation
 */

import { describe, expect, it } from "vitest";
import {
	createEexist,
	createEisdir,
	createEloop,
	createEnoent,
	createEnotdir,
	createEnotempty,
	createEperm,
	sanitizeFsError,
	translateSqlError,
} from "./errors.js";

// ── Error constructors ────────────────────────────────────────────────────────

describe("createEnoent", () => {
	it("produces code ENOENT and includes path in message", () => {
		const err = createEnoent("/home/user/missing.txt") as Error & { code: string; path: string };
		expect(err.code).toBe("ENOENT");
		expect(err.path).toBe("/home/user/missing.txt");
		expect(err.message).toContain("/home/user/missing.txt");
	});
});

describe("createEexist", () => {
	it("produces code EEXIST and includes path in message", () => {
		const err = createEexist("/tmp/existing") as Error & { code: string; path: string };
		expect(err.code).toBe("EEXIST");
		expect(err.path).toBe("/tmp/existing");
		expect(err.message).toContain("/tmp/existing");
	});
});

describe("createEisdir", () => {
	it("produces code EISDIR and includes path in message", () => {
		const err = createEisdir("/home/user") as Error & { code: string; path: string };
		expect(err.code).toBe("EISDIR");
		expect(err.path).toBe("/home/user");
		expect(err.message).toContain("directory");
	});
});

describe("createEnotdir", () => {
	it("produces code ENOTDIR and includes path in message", () => {
		const err = createEnotdir("/home/user/file.txt") as Error & { code: string; path: string };
		expect(err.code).toBe("ENOTDIR");
		expect(err.path).toBe("/home/user/file.txt");
		expect(err.message).toContain("not a directory");
	});
});

describe("createEnotempty", () => {
	it("produces code ENOTEMPTY and includes path in message", () => {
		const err = createEnotempty("/home/user/dir") as Error & { code: string; path: string };
		expect(err.code).toBe("ENOTEMPTY");
		expect(err.path).toBe("/home/user/dir");
		expect(err.message).toContain("not empty");
	});
});

describe("createEloop", () => {
	it("produces code ELOOP and includes path in message", () => {
		const err = createEloop("/home/user/link") as Error & { code: string; path: string };
		expect(err.code).toBe("ELOOP");
		expect(err.path).toBe("/home/user/link");
		expect(err.message).toContain("symbolic links");
	});
});

describe("createEperm", () => {
	it("produces code EPERM and includes path and op in message", () => {
		const err = createEperm("/root/secret", "symlink") as Error & { code: string; path: string };
		expect(err.code).toBe("EPERM");
		expect(err.path).toBe("/root/secret");
		expect(err.message).toContain("symlink");
		expect(err.message).toContain("/root/secret");
	});
});

// ── translateSqlError — Postgres SQLSTATE ─────────────────────────────────────

describe("translateSqlError — Postgres SQLSTATE", () => {
	it("maps 23505 (unique_violation) to EEXIST", () => {
		const raw = Object.assign(new Error("duplicate key"), { code: "23505" });
		const err = translateSqlError(raw, "/tmp/dup") as Error & { code: string };
		expect(err.code).toBe("EEXIST");
	});

	it("maps FS001 to ELOOP", () => {
		const raw = Object.assign(new Error("too many symlinks"), { code: "FS001" });
		const err = translateSqlError(raw, "/tmp/loop") as Error & { code: string };
		expect(err.code).toBe("ELOOP");
	});

	it("maps FS002 to ENOENT", () => {
		const raw = Object.assign(new Error("path not found"), { code: "FS002" });
		const err = translateSqlError(raw, "/tmp/missing") as Error & { code: string };
		expect(err.code).toBe("ENOENT");
	});

	it("maps FS003 to ENOTDIR", () => {
		const raw = Object.assign(new Error("not a dir"), { code: "FS003" });
		const err = translateSqlError(raw, "/tmp/file") as Error & { code: string };
		expect(err.code).toBe("ENOTDIR");
	});
});

// ── translateSqlError — MySQL ─────────────────────────────────────────────────

describe("translateSqlError — MySQL", () => {
	it("maps errno 1062 (ER_DUP_ENTRY) to EEXIST", () => {
		const raw = Object.assign(new Error("Duplicate entry"), { errno: 1062 });
		const err = translateSqlError(raw, "/tmp/dup") as Error & { code: string };
		expect(err.code).toBe("EEXIST");
	});
});

// ── translateSqlError — T-SQL / Azure SQL ─────────────────────────────────────

describe("translateSqlError — T-SQL", () => {
	it("maps error number 2601 to EEXIST", () => {
		const raw = Object.assign(new Error("Cannot insert duplicate row"), { number: 2601 });
		const err = translateSqlError(raw, "/tmp/dup") as Error & { code: string };
		expect(err.code).toBe("EEXIST");
	});

	it("maps error number 2627 to EEXIST", () => {
		const raw = Object.assign(new Error("Violation of UNIQUE KEY"), { number: 2627 });
		const err = translateSqlError(raw, "/tmp/dup") as Error & { code: string };
		expect(err.code).toBe("EEXIST");
	});
});

// ── translateSqlError — unknown errors ───────────────────────────────────────

describe("translateSqlError — unknown errors", () => {
	it("sanitizes and returns original error for unrecognised SQL error", () => {
		const raw = Object.assign(new Error("some unknown db error"), { code: "99999" });
		const err = translateSqlError(raw, "/tmp/x");
		expect(err).toBeInstanceOf(Error);
	});

	it("handles non-Error thrown values", () => {
		const err = translateSqlError("raw string error", "/tmp/x");
		expect(err).toBeInstanceOf(Error);
	});
});

// ── sanitizeFsError ───────────────────────────────────────────────────────────

describe("sanitizeFsError", () => {
	it("strips postgres connection URLs from error messages", () => {
		const err = new Error("failed to connect: postgres://admin:secret@db.example.com:5432/mydb");
		const sanitized = sanitizeFsError(err);
		expect(sanitized.message).not.toContain("postgres://");
		expect(sanitized.message).not.toContain("secret");
		expect(sanitized.message).toContain("[redacted]");
	});

	it("strips internal table names from error messages", () => {
		const err = new Error('relation "inodes" does not exist in table dirents near sandboxes');
		const sanitized = sanitizeFsError(err);
		expect(sanitized.message).not.toContain("inodes");
		expect(sanitized.message).not.toContain("dirents");
		expect(sanitized.message).not.toContain("sandboxes");
		expect(sanitized.message).toContain("[redacted]");
	});

	it("strips host filesystem paths from error messages", () => {
		const err = new Error("permission denied on /var/lib/postgresql/data/base");
		const sanitized = sanitizeFsError(err);
		expect(sanitized.message).not.toContain("/var/lib/postgresql");
		expect(sanitized.message).toContain("[redacted]");
	});

	it("returns original error object unchanged when no sensitive content found", () => {
		const err = new Error("connection timeout after 5000ms");
		const sanitized = sanitizeFsError(err);
		expect(sanitized).toBe(err);
	});

	it("strips T-SQL ADO.NET connection string fragments", () => {
		const err = new Error("Server=myserver.database.windows.net;Initial Catalog=mydb;");
		const sanitized = sanitizeFsError(err);
		expect(sanitized.message).not.toContain("myserver");
		expect(sanitized.message).toContain("[redacted]");
	});
});
