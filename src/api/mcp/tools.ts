/**
 * MCP tool definitions and handlers.
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
 * US-080: MCP tool — bash_exec
 * US-086: MCP tool — fs_ingest
 * US-087: MCP tool — fs_export
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withOwnedSessionOrRehydrate } from "../ownership.js";
import type { SessionManager } from "../session-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * Validates that a relative path is safe (no traversal, no absolute paths, no null bytes).
 */
function isValidRelativePath(p: string): boolean {
	if (p.includes("\0")) return false;
	if (p.startsWith("/")) return false;
	const segments = p.split("/");
	for (const seg of segments) {
		if (seg === "..") return false;
	}
	return true;
}

export function registerTools(server: McpServer, sessionManager: SessionManager, owner: string, tenant: string): void {
	server.tool(
		"sandbox_create",
		"Create an isolated bash sandbox with a virtual filesystem. Optional runtime flags opt in to python3/python (CPython WASM, stdlib only) and js-exec/node (QuickJS WASM) commands.",
		{
			python: z.boolean().optional(),
			javascript: z.boolean().optional(),
		},
		async (args) => {
			const id = randomUUID();
			const runtimeOptions = {
				python: args.python ?? false,
				javascript: args.javascript ?? false,
			};
			await sessionManager.getOrCreate(tenant, id, runtimeOptions, owner);
			await sessionManager.persistSandboxMeta(tenant, id, {
				owner,
				python: runtimeOptions.python,
				javascript: runtimeOptions.javascript,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ id, python: runtimeOptions.python, javascript: runtimeOptions.javascript }),
					},
				],
			};
		},
	);

	server.tool("sandbox_delete", "Delete a sandbox and all its files", { id: z.string() }, async (args) => {
		try {
			await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async () => undefined);
			const existed = await sessionManager.destroy(tenant, args.id);
			if (!existed) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "sandbox not found" }) }],
				};
			}
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
			};
		} catch (err) {
			const code = (err as Error & { code?: string }).code;
			if (code === "FORBIDDEN") {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden" }) }],
				};
			}
			if (code === "ENOENT") {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "sandbox not found" }) }],
				};
			}
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
		"environment variables, conditionals (if/else), loops (for/while), functions, arithmetic,",
		"base64, md5sum, sha256sum, tar, gzip, jq, yq, xan, sqlite3.",
		"",
		"NOT supported: curl/wget (no network), apt/pip/npm (no package managers),",
		"vi/vim/nano (no interactive), background jobs (&), kill/ps/top (no process control),",
		"/proc /sys /dev (no special filesystems), ln -s (symlinks off by default),",
		"gcc/make/rustc (no compilers), network access of any kind.",
		"",
		"Optional runtimes (only if sandbox was created with python:true or javascript:true):",
		"- python3 / python — CPython WASM, stdlib only (no pip, no network, no os.system).",
		"  Concurrent python3 executions across the server are capped to prevent OOM; excess",
		"  scripts queue until a slot frees.",
		"- js-exec / node — QuickJS WASM. TypeScript supported. No npm, no network.",
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
				const result = await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async (session) => {
					const controller = new AbortController();
					let timedOut = false;

					const timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, timeoutMs);

					try {
						const execResult = await sessionManager.execWithRuntimeThrottle(session, args.script, {
							signal: controller.signal,
						});
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
				const code = (err as Error & { code?: string }).code;
				if (code === "FORBIDDEN") {
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify({ stdout: "", stderr: "forbidden", exitCode: 1 }) },
						],
					};
				}
				if (code === "ENOENT") {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ stdout: "", stderr: "sandbox not found", exitCode: 1 }),
							},
						],
					};
				}
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ stdout: "", stderr: message, exitCode: 1 }) }],
				};
			}
		},
	);

	server.tool(
		"fs_ingest",
		"Upload files into sandbox (use before bash_exec to seed project files)",
		{
			id: z.string(),
			basePath: z.string().optional(),
			files: z.record(z.string(), z.string()),
		},
		async (args) => {
			const basePath = args.basePath ?? "/home/user";

			// Validate all relative paths before writing any files
			for (const relativePath of Object.keys(args.files)) {
				if (!isValidRelativePath(relativePath)) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ ok: false, error: `invalid path: ${relativePath}` }),
							},
						],
					};
				}
			}

			try {
				await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async (session) => {
					for (const [relativePath, content] of Object.entries(args.files)) {
						const absPath = `${basePath}/${relativePath}`;
						const lastSlash = absPath.lastIndexOf("/");
						const parentDir = absPath.slice(0, lastSlash);
						if (parentDir) {
							await session.fs.mkdir(parentDir, { recursive: true });
						}
						await session.fs.writeFile(absPath, content);
					}
				});

				return {
					content: [
						{ type: "text" as const, text: JSON.stringify({ ok: true, count: Object.keys(args.files).length }) },
					],
				};
			} catch (err) {
				const code = (err as Error & { code?: string }).code;
				if (code === "FORBIDDEN") {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden" }) }],
					};
				}
				const message = code === "ENOENT" ? "sandbox not found" : err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
				};
			}
		},
	);

	server.tool(
		"fs_export",
		"Download files from sandbox as JSON map",
		{
			id: z.string(),
			basePath: z.string().optional(),
		},
		async (args) => {
			const basePath = args.basePath ?? "/home/user";
			const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

			try {
				const { files, errors } = await withOwnedSessionOrRehydrate(
					sessionManager,
					tenant,
					args.id,
					owner,
					async (session) => {
						const allPaths = session.fs.getAllPaths();
						const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
						const result: Record<string, string> = Object.create(null);
						const readErrors: string[] = [];

						const candidates = allPaths.filter((p) => p.startsWith(prefix));
						await Promise.all(
							candidates.map(async (absPath) => {
								try {
									const buf = await session.fs.readFileBuffer(absPath);
									const relativePath = absPath.slice(prefix.length);
									try {
										result[relativePath] = utf8Decoder.decode(buf);
									} catch {
										result[relativePath] =
											`data:application/octet-stream;base64,${Buffer.from(buf).toString("base64")}`;
									}
								} catch (e) {
									const code = (e as Error & { code?: string }).code;
									// EISDIR is expected — directories cannot be read as files
									if (code !== "EISDIR") {
										readErrors.push(absPath);
									}
								}
							}),
						);

						return { files: result, errors: readErrors };
					},
				);

				if (errors.length > 0) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ files, errors }) }],
					};
				}

				return {
					content: [{ type: "text" as const, text: JSON.stringify({ files }) }],
				};
			} catch (err) {
				const code = (err as Error & { code?: string }).code;
				if (code === "FORBIDDEN") {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden" }) }],
					};
				}
				const message = code === "ENOENT" ? "sandbox not found" : err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
				};
			}
		},
	);
}
