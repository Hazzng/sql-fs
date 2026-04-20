/**
 * MCP tool definitions and handlers.
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
 * US-080: MCP tool — bash_exec
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

export function registerTools(server: McpServer, sessionManager: SessionManager): void {
	server.tool(
		"sandbox_create",
		"Create an isolated bash sandbox with a virtual filesystem",
		{ env: z.record(z.string(), z.string()).optional() },
		async (_args) => {
			const id = randomUUID();
			await sessionManager.getOrCreate(id);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ id }) }],
			};
		},
	);

	server.tool("sandbox_delete", "Delete a sandbox and all its files", { id: z.string() }, async (args) => {
		try {
			await sessionManager.destroy(args.id);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
			};
		}
	});

	const bashExecDescription = [
		"Execute a bash script in a sandbox. Returns stdout, stderr, and exitCode.",
		"",
		"Supported: cat, echo, ls, find, mkdir, rm, mv, cp, touch, chmod, stat, grep, sed, awk,",
		"sort, wc, head, tail, cut, tr, uniq, diff, pipes (|), redirects (>, >>, <),",
		"environment variables, conditionals (if/else), loops (for/while), functions, arithmetic.",
		"",
		"NOT supported: curl, wget, apt, npm, pip, vi, vim, nano, background jobs (&),",
		"process control (kill, ps, top), /proc, /sys, symlinks, compilers (gcc, make),",
		"interpreters (python, node, ruby), network access.",
	].join("\n");

	server.tool(
		"bash_exec",
		bashExecDescription,
		{
			id: z.string(),
			script: z.string(),
			timeout: z.number().int().positive().optional(),
		},
		async (args) => {
			const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

			try {
				const result = await sessionManager.withSession(args.id, async (session) => {
					const controller = new AbortController();
					let timedOut = false;

					const timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, timeoutMs);

					try {
						const execResult = await session.bash.exec(args.script, { signal: controller.signal });
						clearTimeout(timer);
						if (timedOut) {
							return { stdout: "", stderr: "timeout", exitCode: -1 };
						}
						return { stdout: execResult.stdout, stderr: execResult.stderr, exitCode: execResult.exitCode };
					} catch (e) {
						clearTimeout(timer);
						if (timedOut) {
							return { stdout: "", stderr: "timeout", exitCode: -1 };
						}
						throw e;
					}
				});

				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ stdout: "", stderr: message, exitCode: 1 }) }],
				};
			}
		},
	);
}
