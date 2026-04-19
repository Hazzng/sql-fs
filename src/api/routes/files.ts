/**
 * File operation routes.
 * US-062: GET /v1/sandboxes/:id/files/*path — read file
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FsStat } from "just-bash";
import type { AuthVariables } from "../auth.js";
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

		const result = await sessionManager.withSession<ReadResult>(sandboxId, async (session) => {
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

			const content = await session.fs.readFile(filePath);
			const body = new TextEncoder().encode(content);

			return { kind: "ok", body, statHeader };
		});

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

	return router;
}
