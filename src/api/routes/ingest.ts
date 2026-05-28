/**
 * Ingest routes.
 * US-072: POST /v1/sandboxes/:id/ingest-files — JSON manifest upload
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ICoherentFs } from "../../fs/sql-fs/sql-fs.js";
import type { AuthVariables } from "../auth.js";
import { buildBulkIngestPayload } from "../ingest-manifest.js";
import { forbiddenResponse, isForbiddenError, withOwnedSessionOrRehydrate } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

export function ingestRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// POST /v1/sandboxes/:id/ingest-files — JSON manifest upload
	const ingestFilesBodySchema = z.object({
		basePath: z.string().min(1, "basePath is required"),
		files: z.record(z.string(), z.string()),
	});

	router.post("/:id/ingest-files", async (c) => {
		const sandboxId = c.req.param("id");
		const tenant = c.get("tenant");
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: ["Invalid JSON body"] },
				400 as ContentfulStatusCode,
			);
		}

		const parsed = ingestFilesBodySchema.safeParse(raw);
		if (!parsed.success) {
			const details = parsed.error.issues.map((i) => i.message);
			return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
		}

		const { basePath, files } = parsed.data;

		// HTTP intentionally does NOT expose the `paths` (host-filesystem) ingest
		// mode — that's a local-trust capability and lives only on the MCP surface.
		const built = await buildBulkIngestPayload({ basePath, files, allowEmpty: true });
		if (!built.ok) {
			return c.json(
				{ error: "validation_error", code: "INVALID_INPUT", details: built.errors },
				400 as ContentfulStatusCode,
			);
		}
		const { bulkFiles } = built;
		const fileCount = bulkFiles.length;

		try {
			await withOwnedSessionOrRehydrate(sessionManager, tenant, sandboxId, c.get("owner"), async (session) => {
				const fs = session.fs as ICoherentFs;
				if (typeof fs.bulkIngest !== "function") {
					throw Object.assign(new Error("bulkIngest not supported by this fs backend"), { code: "ENOTSUP" });
				}
				await fs.bulkIngest(bulkFiles);
			});
		} catch (e) {
			const code = (e as Error & { code?: string }).code;
			if (isForbiddenError(e)) {
				return forbiddenResponse();
			}
			if (code === "ENOENT") {
				return c.json({ error: "not_found", code: "ENOENT" }, 404 as ContentfulStatusCode);
			}
			// Defensive: in production every replica wires SqlFs (which has bulkIngest),
			// so this branch is only reachable from a misconfigured backend. Translate
			// to a sanitized 500 here rather than letting the raw ENOTSUP code leak
			// through the global handler — `ENOTSUP` isn't part of the public error
			// vocabulary and would surprise clients.
			if (code === "ENOTSUP") {
				console.error(
					JSON.stringify({
						event: "ingest_files_backend_unsupported",
						sandboxId,
						tenant,
					}),
				);
				return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500 as ContentfulStatusCode);
			}
			throw e;
		}

		return c.json({ status: "ok", fileCount });
	});

	return router;
}
