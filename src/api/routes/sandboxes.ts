/**
 * Sandbox CRUD routes.
 * US-059: POST /v1/sandboxes — create sandbox
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import type { SessionManager } from "../session-manager.js";

const createBodySchema = z.object({
	env: z.record(z.string()).optional(),
	files: z.record(z.string()).optional(),
});

export function sandboxRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	router.post("/", async (c) => {
		let files: Record<string, string> | undefined;

		// Body is optional — parse if present, ignore if missing/empty
		try {
			const raw = await c.req.json();
			const result = createBodySchema.safeParse(raw);
			if (!result.success) {
				const details = result.error.issues.map((i) => i.message);
				return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, 400 as ContentfulStatusCode);
			}
			files = result.data.files;
		} catch {
			// No body provided — that's fine
		}

		const owner = c.get("owner");
		const sandboxId = crypto.randomUUID();
		const createdAt = new Date().toISOString();

		await sessionManager.withSession(sandboxId, async (session) => {
			if (files !== undefined) {
				for (const [path, content] of Object.entries(files)) {
					await session.fs.writeFile(path, content);
				}
			}
		});

		return c.json({ id: sandboxId, owner, createdAt }, 201 as ContentfulStatusCode);
	});

	return router;
}
