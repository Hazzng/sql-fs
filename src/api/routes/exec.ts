/**
 * Execution routes.
 * US-068: POST /v1/sandboxes/:id/exec-sync — buffered execution
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import type { SessionManager } from "../session-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

const execBodySchema = z.object({
	script: z.string(),
	cwd: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

export function execRoutes(sessionManager: SessionManager): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// POST /v1/sandboxes/:id/exec-sync — buffered (non-streaming) bash execution
	router.post("/:id/exec-sync", async (c) => {
		const sandboxId = c.req.param("id");

		let body: z.infer<typeof execBodySchema>;
		try {
			const raw = await c.req.json();
			const result = execBodySchema.safeParse(raw);
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

		const timeoutMs = Math.min(body.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

		// Convert user-controlled env keys to null-prototype object to prevent prototype pollution
		const env = body.env ? Object.assign(Object.create(null) as Record<string, string>, body.env) : undefined;

		type ExecSyncResult = { kind: "ok"; stdout: string; stderr: string; exitCode: number } | { kind: "timeout" };

		const execResult = await sessionManager.withSession<ExecSyncResult>(sandboxId, async (session) => {
			const controller = new AbortController();
			let timedOut = false;

			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);

			try {
				const result = await session.bash.exec(body.script, {
					signal: controller.signal,
					cwd: body.cwd,
					env,
				});
				clearTimeout(timer);

				if (timedOut) {
					return { kind: "timeout" };
				}

				return {
					kind: "ok",
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				};
			} catch (e) {
				clearTimeout(timer);
				if (timedOut) {
					return { kind: "timeout" };
				}
				throw e;
			}
		});

		if (execResult.kind === "timeout") {
			return c.json({ error: "timeout", code: "EXEC_TIMEOUT" }, 408 as ContentfulStatusCode);
		}

		return c.json({ stdout: execResult.stdout, stderr: execResult.stderr, exitCode: execResult.exitCode });
	});

	return router;
}
