/**
 * File operation routes.
 * US-062: GET /v1/sandboxes/:id/files/*path — read file
 * US-063: PUT /v1/sandboxes/:id/files/*path — write file
 * US-064: DELETE /v1/sandboxes/:id/files/*path — delete file or dir
 * US-065: POST /v1/sandboxes/:id/mkdir — create directory
 * US-066: POST /v1/sandboxes/:id/writeFiles — bulk write
 * US-067: GET /v1/sandboxes/:id/tree — list file tree
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FsStat } from "just-bash";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
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

/**
 * Extracts a filesystem error code from the error's .code property,
 * or falls back to parsing the POSIX error prefix from the message
 * (e.g. "ENOENT: no such file..." → "ENOENT").
 * InMemoryFs from just-bash does not set .code, so message parsing is required.
 */
function extractErrCode(e: unknown): string | undefined {
	if (!(e instanceof Error)) return undefined;
	const fe = e as Error & { code?: string };
	if (fe.code) return fe.code;
	const match = fe.message.match(/^([A-Z]+):/);
	return match?.[1];
}

function parentDir(filePath: string): string {
	const lastSlash = filePath.lastIndexOf("/");
	return lastSlash <= 0 ? "/" : filePath.slice(0, lastSlash);
}

export function fileRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// GET /v1/sandboxes/:id/files/* — read file content
	// Hono requires /:path{.*} to capture wildcard segments that may contain slashes
	router.get("/:id/files/:path{.*}", async (c) => {
		const sandboxId = c.req.param("id");
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
				"X-FS-Stat": JSON.stringify(result.statHeader),
			},
		});
	});

	// PUT /v1/sandboxes/:id/files/* — write raw file content
	router.put("/:id/files/:path{.*}", async (c) => {
		const sandboxId = c.req.param("id");
		const wildcard = c.req.param("path");
		const filePath = `/${wildcard}`;

		const buffer = await c.req.raw.arrayBuffer();
		const content = new Uint8Array(buffer);

		try {
			await withOwnedSessionOrRehydrate(sessionManager, sandboxId, c.get("owner"), async (session) => {
				const parent = parentDir(filePath);
				if (parent !== "/") {
					try {
						await session.fs.mkdir(parent, { recursive: true });
					} catch (e) {
						const code = extractErrCode(e);
						if (code !== "EEXIST") throw e;
					}
				}
				await session.fs.writeFile(filePath, content);
			});
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		return c.body(null, 204);
	});

	// DELETE /v1/sandboxes/:id/files/* — delete file or directory
	router.delete("/:id/files/:path{.*}", async (c) => {
		const sandboxId = c.req.param("id");
		const wildcard = c.req.param("path");
		const filePath = `/${wildcard}`;
		const recursive = c.req.query("recursive") === "true";

		type DeleteResult = { kind: "ok" } | { kind: "not_found" } | { kind: "not_empty" };

		let result: DeleteResult;
		try {
			result = await withOwnedSessionOrRehydrate<DeleteResult>(
				sessionManager,
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

		try {
			await withOwnedSessionOrRehydrate(sessionManager, sandboxId, c.get("owner"), async (session) => {
				for (const [filePath, content] of Object.entries(files)) {
					const parent = parentDir(filePath);
					if (parent !== "/") {
						try {
							await session.fs.mkdir(parent, { recursive: true });
						} catch (e) {
							const code = extractErrCode(e);
							if (code !== "EEXIST") throw e;
						}
					}
					await session.fs.writeFile(filePath, content);
				}
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
						} catch {
							// Skip paths that can't be stat'd
						}
					}

					return result;
				},
			);
		} catch (err) {
			if (isForbiddenError(err)) return forbiddenResponse();
			throw err;
		}

		return c.json(entries);
	});

	return router;
}
