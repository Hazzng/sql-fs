/**
 * Ingest/Export routes.
 * US-071: POST /v1/sandboxes/:id/ingest — tar.gz upload
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthVariables } from "../auth.js";
import type { SessionManager } from "../session-manager.js";

// Validates that a basePath is a safe absolute path (no shell metacharacters)
function isValidBasePath(p: string): boolean {
	return /^\/[a-zA-Z0-9_\-./]*$/.test(p) && !p.includes("..");
}

/** Returns 403 response if caller does not own the sandbox, undefined otherwise */
function checkOwnership(sessionManager: SessionManager, sandboxId: string, caller: string): Response | undefined {
	const session = sessionManager.getSession(sandboxId);
	if (session?.owner && session.owner !== caller) {
		return Response.json({ error: "forbidden", code: "FORBIDDEN" }, { status: 403 });
	}
	return undefined;
}

export function ingestRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// POST /v1/sandboxes/:id/ingest — upload tar.gz and extract into sandbox
	router.post("/:id/ingest", async (c) => {
		const sandboxId = c.req.param("id");
		const ownershipErr = checkOwnership(sessionManager, sandboxId, c.get("owner"));
		if (ownershipErr) return ownershipErr;

		const body = await c.req.parseBody();
		const archiveField = body.archive;
		const basePathField = body.basePath;
		const basePath =
			typeof basePathField === "string" && basePathField.length > 0 ? basePathField : "/home/user/project";

		if (!(archiveField instanceof File)) {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["archive field is required and must be a file"] },
				400 as ContentfulStatusCode,
			);
		}

		if (!isValidBasePath(basePath)) {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["basePath must be a safe absolute path"] },
				400 as ContentfulStatusCode,
			);
		}

		const archiveBuffer = new Uint8Array(await archiveField.arrayBuffer());

		await sessionManager.withSession(sandboxId, async (session) => {
			// Ensure /tmp exists before writing archive
			try {
				await session.fs.mkdir("/tmp", { recursive: true });
			} catch (e) {
				const code = (e as Error & { code?: string }).code;
				if (code !== "EEXIST") throw e;
			}

			// Write archive to sandbox FS at /tmp/_ingest.tar.gz
			await session.fs.writeFile("/tmp/_ingest.tar.gz", archiveBuffer);

			// Extract via bash (just-bash requires dash-prefixed flags: -xzf not xzf)
			await session.bash.exec(
				`mkdir -p '${basePath}' && cd '${basePath}' && tar -xzf /tmp/_ingest.tar.gz && rm /tmp/_ingest.tar.gz`,
			);
		});

		return c.json({ status: "ok", basePath });
	});

	return router;
}
