/**
 * File operation routes.
 * US-062: GET /v1/sandboxes/:id/files/*path — read file
 * US-063: PUT /v1/sandboxes/:id/files/*path — write file
 * US-064: DELETE /v1/sandboxes/:id/files/*path — delete file or dir
 * PATCH /v1/sandboxes/:id/files/*path — replace a string inside an existing file
 * US-065: POST /v1/sandboxes/:id/mkdir — create directory
 * US-066: POST /v1/sandboxes/:id/writeFiles — bulk write
 * US-067: GET /v1/sandboxes/:id/tree — list file tree
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FsStat } from "just-bash";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import { extractErrCode } from "../errors.js";
import { MAX_FILE_WRITE_BYTES as MAX_RAW_FILE_WRITE_BYTES } from "../lib/env.js";
import { type EditOutcome, editFile, ensureParentDir } from "../lib/file-ops.js";
import { forbiddenResponse, isForbiddenError, withOwnedSessionOrRehydrate } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

// Simple extension → MIME type map (null-prototype to prevent prototype pollution)
const MIME_TYPES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
	".html": "text/html",
	".htm": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".ts": "text/typescript",
	".json": "application/json",
	".txt": "text/plain",
	".md": "text/markdown",
	".xml": "application/xml",
	".sh": "application/x-sh",
	".py": "text/x-python",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".csv": "text/csv",
	".yaml": "application/yaml",
	".yml": "application/yaml",
});

function inferContentType(path: string): string {
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1) return "application/octet-stream";
	const ext = path.slice(lastDot).toLowerCase();
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

function toKind(stat: FsStat): string {
	if (stat.isFile) return "file";
	if (stat.isDirectory) return "dir";
	return "symlink";
}

const MAX_BULK_WRITE_FILES = Number(process.env.MAX_BULK_WRITE_FILES ?? "1000");
const MAX_BULK_WRITE_BYTES = Number(process.env.MAX_BULK_WRITE_BYTES ?? `${128 * 1024 * 1024}`);
// Audit H11 (#27): cap the number of entries a single /tree response materializes.
const MAX_TREE_ENTRIES = Number(process.env.MAX_TREE_ENTRIES ?? "50000");

export function fileRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// A write is bounded by the same limit as the file it produces, and the global body cap is four
	// times looser. Content-Length only ever shortens the work: a request that declares too much is
	// refused unread, but every byte is counted as it streams, so a chunked body carrying no header
	// — or one that under-declares — is cut off rather than trusted. (hono's own `bodyLimit` skips
	// the counting whenever the declared length fits, which is exactly the case a liar declares.)
	const writeBodyLimit = (subject: string): MiddlewareHandler<{ Variables: AuthVariables }> => {
		const tooLarge = (c: Context<{ Variables: AuthVariables }>): Response =>
			c.json(
				{
					error: "payload_too_large",
					code: "PAYLOAD_TOO_LARGE",
					details: [`${subject} exceeds limit (${MAX_RAW_FILE_WRITE_BYTES} bytes)`],
				},
				413 as ContentfulStatusCode,
			);

		return async (c, next) => {
			const declared = Number(c.req.header("content-length"));
			if (Number.isFinite(declared) && declared > MAX_RAW_FILE_WRITE_BYTES) return tooLarge(c);

			const body = c.req.raw.body;
			if (body === null) return next();

			let overflowed = false;
			let seen = 0;
			const reader = body.getReader();
			const counted = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							seen += value.byteLength;
							if (seen > MAX_RAW_FILE_WRITE_BYTES) {
								overflowed = true;
								// Error the stream so the handler cannot act on a body it only half received,
								// and cancel the source so the rest of the upload is not left streaming into a
								// reader nobody will drain.
								await reader.cancel().catch(() => {});
								controller.error(new Error("body exceeds limit"));
								return;
							}
							controller.enqueue(value);
						}
						controller.close();
					} catch (err) {
						controller.error(err);
					}
				},
				cancel(reason) {
					return reader.cancel(reason);
				},
			});
			c.req.raw = new Request(c.req.raw, { body: counted, duplex: "half" } as RequestInit);

			await next();
			// Whatever the handler made of the aborted read — a 400, a 500 — the honest answer is 413.
			if (overflowed) c.res = tooLarge(c);
		};
	};

	// GET /v1/sandboxes/:id/files/* — read file content
	// Hono requires /:path{.*} to capture wildcard segments that may contain slashes
	router.get("/:id/files/:path{.*}", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		const wildcard = c.req.param("path");
		const filePath = `/${wildcard}`;

		type ReadResult =
			| { kind: "ok"; body: Uint8Array; statHeader: { kind: string; mode: number; size: number; mtime: string } }
			| { kind: "not_found" }
			| { kind: "eisdir" };

		let result: ReadResult;
		try {
			result = await withOwnedSessionOrRehydrate<ReadResult>(
				sessionManager,
				tenant,
				sandboxId,
				c.get("owner"),
				async (session) => {
					let stat: FsStat;
					try {
						stat = await session.fs.stat(filePath);
					} catch (e) {
						const code = extractErrCode(e);
						if (code === "ENOENT") return { kind: "not_found" };
						throw e;
					}

					if (stat.isDirectory) {
						return { kind: "eisdir" };
					}

					const statHeader = {
						kind: toKind(stat),
						mode: stat.mode,
						size: stat.size,
						mtime: stat.mtime.toISOString(),
					};

					// Use readFileBuffer if available (SqlFs), otherwise fall back to text-based readFile
					const fs = session.fs as { readFileBuffer?: (path: string) => Promise<Uint8Array> };
					let body: Uint8Array;
					if (typeof fs.readFileBuffer === "function") {
						body = await fs.readFileBuffer(filePath);
					} else {
						const content = await session.fs.readFile(filePath);
						body = new TextEncoder().encode(content);
					}

					return { kind: "ok", body, statHeader };
				},
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		if (result.kind === "not_found") {
			return c.json({ error: "not_found", code: "ENOENT" }, 404 as ContentfulStatusCode);
		}
		if (result.kind === "eisdir") {
			return c.json({ error: "is_directory", code: "EISDIR" }, 400 as ContentfulStatusCode);
		}

		return new Response(result.body, {
			headers: {
				"Content-Type": inferContentType(filePath),
				// Audit M3: file bytes are attacker-controlled. Prevent a browser from
				// MIME-sniffing or rendering them as active content (stored XSS via
				// text/html, image/svg+xml, JS, …). nosniff + forced download +
				// a locked-down CSP neutralize inline execution; programmatic clients
				// read the body regardless of Content-Disposition.
				"X-Content-Type-Options": "nosniff",
				"Content-Disposition": "attachment",
				"Content-Security-Policy": "default-src 'none'; sandbox",
				"X-FS-Stat": JSON.stringify(result.statHeader),
			},
		});
	});

	// PUT /v1/sandboxes/:id/files/* — write raw file content
	router.put("/:id/files/:path{.*}", writeBodyLimit("File body"), async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		const wildcard = c.req.param("path");
		const filePath = `/${wildcard}`;

		// The limiter above aborts the stream past the cap, so this never buffers an oversized body.
		const buffer = await c.req.raw.arrayBuffer();
		const content = new Uint8Array(buffer);

		try {
			await withOwnedSessionOrRehydrate(sessionManager, tenant, sandboxId, c.get("owner"), async (session) => {
				await ensureParentDir(session.fs, filePath);
				await session.fs.writeFile(filePath, content);
			});
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		return c.body(null, 204);
	});

	// PATCH /v1/sandboxes/:id/files/* — replace a string inside an existing file
	const editBodySchema = z.object({
		oldString: z.string().min(1, "oldString is required"),
		newString: z.string(),
		replaceAll: z.boolean().optional(),
	});

	router.patch("/:id/files/:path{.*}", writeBodyLimit("Edit body"), async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		const filePath = `/${c.req.param("path")}`;

		let body: z.infer<typeof editBodySchema>;
		try {
			const result = editBodySchema.safeParse(await c.req.json());
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			body = result.data;
		} catch {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["Invalid JSON body"] },
				400 as ContentfulStatusCode,
			);
		}

		const { oldString, newString, replaceAll = false } = body;
		if (oldString === newString) {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["oldString and newString must differ"] },
				400 as ContentfulStatusCode,
			);
		}

		let result: EditOutcome;
		try {
			result = await withOwnedSessionOrRehydrate<EditOutcome>(
				sessionManager,
				tenant,
				sandboxId,
				c.get("owner"),
				(session) => editFile(session, filePath, { oldString, newString, replaceAll }, MAX_RAW_FILE_WRITE_BYTES),
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		switch (result.kind) {
			case "not_found":
				return c.json({ error: "not_found", code: "ENOENT" }, 404 as ContentfulStatusCode);
			case "eisdir":
				return c.json({ error: "path_is_a_directory", code: "EISDIR" }, 400 as ContentfulStatusCode);
			case "binary":
				return c.json(
					{ error: "not_utf8_text", code: "EDIT_BINARY", details: ["File is not valid UTF-8 text"] },
					400 as ContentfulStatusCode,
				);
			case "no_match":
				return c.json(
					{ error: "old_string_not_found", code: "EDIT_NO_MATCH", details: ["oldString does not appear in the file"] },
					409 as ContentfulStatusCode,
				);
			case "not_unique":
				return c.json(
					{
						error: "old_string_not_unique",
						code: "EDIT_NOT_UNIQUE",
						details: [`oldString appears ${result.count} times; pass replaceAll or include more context`],
					},
					409 as ContentfulStatusCode,
				);
			case "too_large":
				return c.json(
					{
						error: "payload_too_large",
						code: "PAYLOAD_TOO_LARGE",
						details: [`Edited file would exceed limit (${MAX_RAW_FILE_WRITE_BYTES} bytes)`],
					},
					413 as ContentfulStatusCode,
				);
			default:
				return c.json({ path: filePath, replacements: result.replacements, size: result.size });
		}
	});

	// DELETE /v1/sandboxes/:id/files/* — delete file or directory
	router.delete("/:id/files/:path{.*}", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		const wildcard = c.req.param("path");
		const filePath = `/${wildcard}`;
		const recursive = c.req.query("recursive") === "true";

		type DeleteResult = { kind: "ok" } | { kind: "not_found" } | { kind: "not_empty" };

		let result: DeleteResult;
		try {
			result = await withOwnedSessionOrRehydrate<DeleteResult>(
				sessionManager,
				tenant,
				sandboxId,
				c.get("owner"),
				async (session) => {
					try {
						await session.fs.rm(filePath, { recursive });
						return { kind: "ok" };
					} catch (e) {
						const code = extractErrCode(e);
						if (code === "ENOENT") return { kind: "not_found" };
						if (code === "ENOTEMPTY") return { kind: "not_empty" };
						throw e;
					}
				},
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		if (result.kind === "not_found") {
			return c.json({ error: "not_found", code: "ENOENT" }, 404 as ContentfulStatusCode);
		}
		if (result.kind === "not_empty") {
			return c.json({ error: "directory_not_empty", code: "ENOTEMPTY" }, 409 as ContentfulStatusCode);
		}

		return c.body(null, 204);
	});

	// POST /v1/sandboxes/:id/writeFiles — bulk write files
	const writeFilesBodySchema = z.object({
		files: z.record(z.string(), z.string()),
	});

	router.post("/:id/writeFiles", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		let body: z.infer<typeof writeFilesBodySchema>;
		try {
			const raw = await c.req.json();
			const result = writeFilesBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			body = result.data;
		} catch {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["Invalid JSON body"] },
				400 as ContentfulStatusCode,
			);
		}

		const { files } = body;
		const fileEntries = Object.entries(files);
		// Audit M5: reject blank keys up-front with a clear error. (Defense in depth:
		// even without this, an empty/degenerate key normalizes to "/" and is
		// rejected with EISDIR by the write guard, so no corrupt inode is created.)
		if (fileEntries.some(([key]) => key.trim() === "")) {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["file keys must be non-empty paths"] },
				400 as ContentfulStatusCode,
			);
		}
		if (fileEntries.length > MAX_BULK_WRITE_FILES) {
			return c.json(
				{
					error: "payload_too_large",
					code: "PAYLOAD_TOO_LARGE",
					details: [`Bulk write exceeds file count limit (${MAX_BULK_WRITE_FILES})`],
				},
				413 as ContentfulStatusCode,
			);
		}
		let totalBytes = 0;
		for (const [, content] of fileEntries) {
			totalBytes += Buffer.byteLength(content, "utf8");
			if (totalBytes > MAX_BULK_WRITE_BYTES) {
				return c.json(
					{
						error: "payload_too_large",
						code: "PAYLOAD_TOO_LARGE",
						details: [`Bulk write exceeds total byte limit (${MAX_BULK_WRITE_BYTES})`],
					},
					413 as ContentfulStatusCode,
				);
			}
		}

		try {
			await withOwnedSessionOrRehydrate(sessionManager, tenant, sandboxId, c.get("owner"), async (session) => {
				const writeAll = async (): Promise<void> => {
					for (const [filePath, content] of fileEntries) {
						await ensureParentDir(session.fs, filePath);
						await session.fs.writeFile(filePath, content);
					}
				};

				// Audit H10: make the bulk write atomic. Wrap the whole batch in a
				// single script-tx scope so a mid-batch failure rolls back ALL files
				// instead of leaving earlier writes committed. Backends without
				// script-tx support (e.g. in-memory) fall back to the per-entry loop.
				const scriptTx = session.scriptTx;
				if (scriptTx !== undefined) await scriptTx.run(writeAll);
				else await writeAll();
			});
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		return c.body(null, 204);
	});

	// POST /v1/sandboxes/:id/mkdir — create directory
	const mkdirBodySchema = z.object({
		path: z.string().min(1, "path is required"),
		recursive: z.boolean().optional(),
	});

	router.post("/:id/mkdir", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		let body: z.infer<typeof mkdirBodySchema>;
		try {
			const raw = await c.req.json();
			const result = mkdirBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			body = result.data;
		} catch {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["Invalid JSON body"] },
				400 as ContentfulStatusCode,
			);
		}

		const { path: dirPath, recursive = false } = body;

		type MkdirResult = { kind: "ok" } | { kind: "exists" };

		let result: MkdirResult;
		try {
			result = await withOwnedSessionOrRehydrate<MkdirResult>(
				sessionManager,
				tenant,
				sandboxId,
				c.get("owner"),
				async (session) => {
					try {
						await session.fs.mkdir(dirPath, { recursive });
						return { kind: "ok" };
					} catch (e) {
						const code = extractErrCode(e);
						if (code === "EEXIST") return { kind: "exists" };
						throw e;
					}
				},
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		if (result.kind === "exists") {
			return c.json({ error: "already_exists", code: "EEXIST" }, 409 as ContentfulStatusCode);
		}

		return c.body(null, 204);
	});

	// GET /v1/sandboxes/:id/tree — list file tree with optional prefix and depth filters
	const treeQuerySchema = z.object({
		prefix: z.string().default("/"),
		depth: z.coerce.number().int().positive().optional(),
	});

	router.get("/:id/tree", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		const queryResult = treeQuerySchema.safeParse(c.req.query());
		if (!queryResult.success) {
			const details = queryResult.error.issues.map((i) => i.message);
			return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
		}

		const { prefix, depth } = queryResult.data;
		// Normalize: strip trailing slash unless root
		const normalizedPrefix = prefix === "/" ? "/" : prefix.replace(/\/$/, "");

		type TreeEntry = { path: string; kind: string; size: number; mtime: string };

		let entries: TreeEntry[];
		try {
			entries = await withOwnedSessionOrRehydrate<TreeEntry[]>(
				sessionManager,
				tenant,
				sandboxId,
				c.get("owner"),
				async (session) => {
					const allPaths = session.fs.getAllPaths();
					const result: TreeEntry[] = [];

					for (const p of allPaths) {
						// Skip the prefix dir itself
						if (p === normalizedPrefix) continue;

						// Filter by prefix
						if (normalizedPrefix !== "/") {
							if (!p.startsWith(`${normalizedPrefix}/`)) continue;
						}

						// Filter by depth (relative segments below prefix)
						if (depth !== undefined) {
							const relative = normalizedPrefix === "/" ? p.slice(1) : p.slice(normalizedPrefix.length + 1);
							const segments = relative.split("/").filter(Boolean).length;
							if (segments > depth) continue;
						}

						try {
							const stat = await session.fs.stat(p);
							result.push({
								path: p,
								kind: toKind(stat),
								size: stat.size,
								mtime: stat.mtime.toISOString(),
							});
							if (result.length > MAX_TREE_ENTRIES) {
								throw Object.assign(new Error("tree too large"), { code: "PAYLOAD_TOO_LARGE" });
							}
						} catch (e) {
							// Surface the size guard; otherwise skip paths that can't be stat'd.
							if ((e as { code?: string }).code === "PAYLOAD_TOO_LARGE") throw e;
						}
					}

					return result;
				},
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			if ((err as { code?: string }).code === "PAYLOAD_TOO_LARGE") {
				return c.json(
					{
						error: "payload_too_large",
						code: "PAYLOAD_TOO_LARGE",
						details: [`Tree exceeds ${MAX_TREE_ENTRIES} entries; narrow with prefix/depth`],
					},
					413 as ContentfulStatusCode,
				);
			}
			throw err;
		}

		return c.json(entries);
	});

	return router;
}
