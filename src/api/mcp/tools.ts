/**
 * MCP tool definitions and handlers.
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
 * US-080: MCP tool — bash_exec
 * US-086: MCP tool — fs_ingest
 * US-087: MCP tool — fs_export
 * MCP tools — file_read / file_write / file_edit (file access without shell quoting)
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FsStat } from "just-bash";
import { z } from "zod";
import type { ICoherentFs } from "../../sql-fs/sql-fs.js";
import { extractErrCode } from "../errors.js";
import { prepareBulkIngestPayload } from "../ingest-manifest.js";
import { executeBatch } from "../lib/batch-exec.js";
import { MAX_FILE_WRITE_BYTES as MAX_EDIT_BYTES, positiveIntEnv } from "../lib/env.js";
import { editFile, writeFileAtPath } from "../lib/file-ops.js";
import { MAX_PATH_CHARS, posixNormalizePath } from "../lib/paths.js";
import { retainedInputBytes } from "../lib/request-input.js";
import { createForbiddenError, isOwnedBy, withOwnedSessionOrRehydrate, withOwnedSessionRead } from "../ownership.js";
import { sessionLeaseSignal } from "../session-lease-context.js";
import type { SessionManager } from "../session-manager.js";
import { workerRequestContext } from "../worker-owner/request-context.js";
import { withWorkerToolContext } from "./request-context.js";
import {
	batchToolError,
	executionToolError,
	exportToolError,
	toolFailure as fail,
	fileToolError,
	ingestToolError,
	metadataToolError,
	sandboxDeleteToolError,
} from "./tool-errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

/** Refuse to open a file larger than this at all; agents should page it or use bash_exec. */
const MAX_READ_FILE_BYTES = positiveIntEnv(process.env.MAX_MCP_READ_FILE_BYTES, 16 * 1024 * 1024);
/** Cap what one file_read returns, so a whole-file read cannot flood the client. */
const MAX_READ_RESPONSE_BYTES = positiveIntEnv(process.env.MAX_MCP_READ_RESPONSE_BYTES, 1024 * 1024);

// Audit H11 (#39, #44): bound fs_export so a large sandbox can't be materialized
// unboundedly into one in-memory JSON map / opened all at once.
const MAX_EXPORT_FILES = Number(process.env.MAX_EXPORT_FILES ?? "10000");
const MAX_EXPORT_BYTES = Number(process.env.MAX_EXPORT_BYTES ?? `${256 * 1024 * 1024}`);
/** Steps the export read loop, so it must be a positive integer (0/NaN would hang or no-op). */
const MAX_EXPORT_CONCURRENCY = positiveIntEnv(process.env.MAX_EXPORT_CONCURRENCY, 16);

/** Sandbox paths are absolute; accept a relative one rather than failing on a missing slash. */
/** Bytes this string will occupy once JSON-escaped into the response, its quotes excluded. */
function jsonSize(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * Lines in `text`, counted as `split("\n")` would (empty file: 0), without a slot per line — a 16 MiB
 * file of newlines would otherwise materialize ~16M of them for a reply capped at 1 MiB.
 */
function countLines(text: string): number {
	if (text.length === 0) return 0;
	let count = 1;
	let idx = text.indexOf("\n");
	while (idx !== -1) {
		count += 1;
		idx = text.indexOf("\n", idx + 1);
	}
	return count;
}

/** Character offset where 1-based line `n` starts, or the end of `text` when it has fewer lines. */
function lineStartOffset(text: string, n: number): number {
	if (n <= 1) return 0;
	let idx = 0;
	for (let seen = 1; seen < n; seen += 1) {
		const nl = text.indexOf("\n", idx);
		if (nl === -1) return text.length;
		idx = nl + 1;
	}
	return idx;
}

/**
 * Walk an offset back to the start of a UTF-8 codepoint so a resumed read never opens mid-sequence
 * (a caller that passes back our own `nextByteOffset` already lands on one; this covers a hand-written
 * offset, which would otherwise decode to a leading replacement char).
 */
function snapToCodepointStart(bytes: Buffer, offset: number): number {
	let i = Math.min(Math.max(offset, 0), bytes.byteLength);
	while (i > 0 && i < bytes.byteLength && ((bytes[i] ?? 0) & 0xc0) === 0x80) i--;
	return i;
}

function toAbsolute(path: string): string {
	// Root-relative by this tool's own documented contract ("accept a relative one rather than
	// failing on a missing slash"), then normalized: the backends resolve `..` and `//` themselves,
	// so an un-normalized argument reads the right file while every echo of it — the `path` field in
	// this tool's own reply — stays as long as the caller chose to make it.
	return posixNormalizePath(path.startsWith("/") ? path : `/${path}`);
}

export function registerTools(server: McpServer, sessionManager: SessionManager, owner: string, tenant: string): void {
	server.tool(
		"sandbox_create",
		"Create an isolated bash sandbox with a virtual filesystem. Optional runtime flags opt in to python3/python (CPython WASM, stdlib only), js-exec/node (QuickJS WASM), and outbound HTTPS for curl plus git clone/fetch/push. Optional name for human-readable identification.",
		{
			name: z.string().max(255).optional().describe("Human-readable name for the sandbox"),
			python: z.boolean().optional(),
			javascript: z.boolean().optional(),
			network: z.boolean().optional().describe("Grant outbound HTTPS (enables curl + git clone/fetch/push)"),
		},
		withWorkerToolContext(async (args) => {
			const id = randomUUID();
			const name = args.name ?? null;
			const runtimeOptions = {
				python: args.python ?? false,
				javascript: args.javascript ?? false,
				network: args.network ?? false,
			};

			const session = await sessionManager.getOrCreate(tenant, id, runtimeOptions, owner);
			sessionManager.initializeSessionMetadata(session, owner, name);
			await sessionManager.persistSandboxMeta(tenant, id, {
				owner,
				name,
				python: runtimeOptions.python,
				javascript: runtimeOptions.javascript,
				network: runtimeOptions.network,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							id,
							name,
							python: runtimeOptions.python,
							javascript: runtimeOptions.javascript,
							network: runtimeOptions.network,
						}),
					},
				],
			};
		}, metadataToolError),
	);

	server.tool(
		"sandbox_list",
		"List all sandboxes owned by the current user. Returns id, name, owner, createdAt, and runtime flags for each sandbox.",
		{},
		withWorkerToolContext(async () => {
			const sandboxes = await sessionManager.listSandboxes(tenant, owner);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							sandboxes: sandboxes.map((s) => ({
								id: s.id,
								name: s.name,
								owner: s.owner,
								createdAt: s.createdAt.toISOString(),
								python: s.python,
								javascript: s.javascript,
								network: s.network,
							})),
						}),
					},
				],
			};
		}, metadataToolError),
	);

	server.tool(
		"file_read",
		"Read one sandbox file as text. Returns the whole file by default; pass offset/limit to page through a large one, and byteOffset to resume a response that came back truncated. Use this instead of `bash_exec 'cat …'` so the content comes back structured and bounded rather than through shell quoting.",
		{
			id: z.string(),
			path: z.string().min(1).max(MAX_PATH_CHARS).describe("Absolute path inside the sandbox, e.g. /src/index.ts"),
			offset: z.number().int().positive().optional().describe("1-based line to start from"),
			limit: z.number().int().positive().optional().describe("Maximum number of lines to return"),
			byteOffset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"Resume a truncated read from this byte offset in the file: pass the previous response's nextByteOffset",
				),
		},
		withWorkerToolContext(async (args) => {
			const filePath = toAbsolute(args.path);

			const outcome = await withOwnedSessionRead(sessionManager, tenant, args.id, owner, async (session) => {
				let stat: FsStat;
				try {
					stat = await session.fs.stat(filePath);
				} catch (e) {
					if (extractErrCode(e) === "ENOENT") return { kind: "not_found" } as const;
					throw e;
				}
				if (stat.isDirectory) return { kind: "eisdir" } as const;
				if (stat.size > MAX_READ_FILE_BYTES) return { kind: "file_too_large", size: stat.size } as const;

				const bytes = await session.fs.readFileBuffer(filePath);

				let text: string;
				try {
					// `ignoreBOM` keeps a leading U+FEFF in the string rather than consuming it, matching
					// `editFile`: a read whose content is written back must not silently drop the marker,
					// and the byte offsets below are only the file's own if the text round-trips exactly.
					text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
				} catch {
					return { kind: "not_text" } as const;
				}

				const paging = args.offset !== undefined || args.limit !== undefined;
				const totalLines = countLines(text);
				const firstLine = args.offset ?? 1;
				const selectionStartChar = paging ? lineStartOffset(text, firstLine) : 0;
				let selectionEndChar = text.length;
				// `join("\n")` drops the separator before the next line, so the slice stops one short of it
				// — but only when that line exists. The empty line after a trailing newline starts AT the
				// end, so deciding this from the offset kept a newline `split`/`join` would have dropped.
				if (paging && args.limit !== undefined && firstLine + args.limit <= totalLines) {
					selectionEndChar = lineStartOffset(text, firstLine + args.limit) - 1;
				}
				const selected = paging ? text.slice(selectionStartChar, selectionEndChar) : text;

				// Byte offsets are absolute in the file, not relative to a paged selection, so a resume
				// means the same thing whether or not the caller repeats the original offset/limit.
				const selectionStart =
					selectionStartChar === 0 ? 0 : Buffer.byteLength(text.slice(0, selectionStartChar), "utf8");
				const selectedBytes = Buffer.from(selected, "utf8");
				const start = snapToCodepointStart(
					selectedBytes,
					args.byteOffset === undefined ? 0 : args.byteOffset - selectionStart,
				);

				const replyFor = (cut: number): string => {
					const isTruncated = cut < selectedBytes.byteLength;
					return JSON.stringify({
						ok: true,
						path: filePath,
						content: selectedBytes.subarray(start, cut).toString("utf8"),
						size: stat.size,
						totalLines,
						firstLine,
						truncated: isTruncated,
						...(isTruncated ? { nextByteOffset: selectionStart + cut } : {}),
					});
				};

				// Bound what crosses the wire even when the whole file was requested. The budget is in
				// bytes but the paging controls are in lines, so a line longer than the budget would
				// strand its own tail — no offset can reach past the first megabyte of one line. The cut
				// point comes back as `nextByteOffset` for the caller to resume from. Cutting on a
				// codepoint boundary keeps a split character out of the response without having to guess
				// afterwards whether a trailing U+FFFD was the file's own or one we made.
				let end = snapToCodepointStart(
					selectedBytes,
					Math.min(start + MAX_READ_RESPONSE_BYTES, selectedBytes.byteLength),
				);
				let reply = replyFor(end);
				// A budget below the envelope has no honest page: the reply would exceed the cap and its
				// `nextByteOffset` would equal the offset asked for, resuming forever without advancing.
				if (jsonSize(replyFor(start)) > MAX_READ_RESPONSE_BYTES) {
					return { kind: "budget_too_small" } as const;
				}
				// Sized on the form the wire carries: the MCP transport serializes this text again inside
				// the JSON-RPC result, re-escaping every backslash, so a page of NULs budgeted on the
				// inner form lands ~17% over. `end - 1` guarantees progress if the ratio does not.
				while (end > start && jsonSize(reply) > MAX_READ_RESPONSE_BYTES) {
					const fit = MAX_READ_RESPONSE_BYTES / jsonSize(reply);
					const proposed = start + Math.max(1, Math.floor((end - start) * fit));
					end = snapToCodepointStart(selectedBytes, Math.min(proposed, end - 1));
					reply = replyFor(end);
				}
				if (end === start && start < selectedBytes.byteLength) return { kind: "budget_too_small" } as const;
				return { kind: "ok", reply } as const;
			});

			switch (outcome.kind) {
				case "not_found":
					return fail("file not found", { code: "ENOENT", path: filePath });
				case "eisdir":
					return fail("path is a directory", { code: "EISDIR", path: filePath });
				case "not_text":
					return fail("file is not valid UTF-8 text", { code: "NOT_TEXT", path: filePath });
				case "file_too_large":
					return fail(`file is ${outcome.size} bytes; exceeds the read limit (${MAX_READ_FILE_BYTES})`, {
						code: "PAYLOAD_TOO_LARGE",
						path: filePath,
					});
				case "budget_too_small":
					return fail(
						`MAX_MCP_READ_RESPONSE_BYTES (${MAX_READ_RESPONSE_BYTES}) is too small to hold a usable response for this path`,
						{ code: "RESPONSE_BUDGET_TOO_SMALL", path: filePath },
					);
				default:
					// Serialized under the budget above, not re-assembled here: rebuilding it would
					// reintroduce the unmeasured envelope this cap exists to account for.
					return { content: [{ type: "text" as const, text: outcome.reply }] };
			}
		}, fileToolError),
	);

	server.tool(
		"file_write",
		"Write a whole sandbox file, creating parent directories and overwriting any existing content. Use file_edit instead when changing part of an existing file — it avoids resending the whole file.",
		{
			id: z.string(),
			path: z.string().min(1).max(MAX_PATH_CHARS).describe("Absolute path inside the sandbox, e.g. /src/index.ts"),
			content: z.string().describe("Full file content. Replaces the file entirely."),
		},
		withWorkerToolContext(async (args, extra) => {
			const filePath = toAbsolute(args.path);
			// Encode once: `writeFile` would otherwise re-encode the same string internally.
			const encoded = new TextEncoder().encode(args.content);
			const size = encoded.byteLength;
			if (size > MAX_EDIT_BYTES) {
				return fail(`content is ${size} bytes; exceeds the write limit (${MAX_EDIT_BYTES})`, {
					code: "PAYLOAD_TOO_LARGE",
					path: filePath,
				});
			}

			const outcome = await workerRequestContext.run(
				{ bytes: retainedInputBytes(args) + encoded.byteLength, signal: extra?.signal },
				() =>
					withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, (session) =>
						writeFileAtPath(session, filePath, encoded),
					),
			);

			if (outcome.kind === "eisdir") return fail("path is a directory", { code: "EISDIR", path: filePath });
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: true, path: filePath, size }) }],
			};
		}, fileToolError),
	);

	server.tool(
		"file_edit",
		"Replace an exact string inside one existing sandbox file. Reads, patches and writes atomically, so it is the cheapest way to change code without shipping the whole file. oldString must match exactly once unless replaceAll is true — an ambiguous match is rejected rather than guessed at. Read the file first with file_read so oldString reflects current content — bash_exec 'cat <shell-quoted path>' only for files past file_read's limits.",
		{
			id: z.string(),
			path: z.string().min(1).max(MAX_PATH_CHARS).describe("Absolute path inside the sandbox, e.g. /src/index.ts"),
			oldString: z.string().min(1).describe("Exact text to replace, including surrounding context to make it unique"),
			newString: z.string().describe("Replacement text. Pass an empty string to delete the matched text."),
			replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match"),
		},
		withWorkerToolContext(async (args) => {
			if (args.oldString === args.newString) return fail("oldString and newString must differ");
			const filePath = toAbsolute(args.path);

			const outcome = await withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, (session) =>
				editFile(
					session,
					filePath,
					{ oldString: args.oldString, newString: args.newString, replaceAll: args.replaceAll },
					MAX_EDIT_BYTES,
				),
			);

			switch (outcome.kind) {
				case "not_found":
					return fail("file not found", { code: "ENOENT", path: filePath });
				case "eisdir":
					return fail("path is a directory", { code: "EISDIR", path: filePath });
				case "binary":
					return fail("file is not valid UTF-8 text", { code: "EDIT_BINARY", path: filePath });
				case "no_match":
					return fail("oldString does not appear in the file", { code: "EDIT_NO_MATCH", path: filePath });
				case "not_unique":
					return fail(`oldString appears ${outcome.count} times; pass replaceAll or include more context`, {
						code: "EDIT_NOT_UNIQUE",
						occurrences: outcome.count,
						path: filePath,
					});
				case "too_large":
					return fail("edited file exceeds the size limit", { code: "PAYLOAD_TOO_LARGE", path: filePath });
				case "lone_surrogate":
					return fail("oldString and newString must be well-formed text; a lone surrogate matches half a character", {
						code: "EDIT_LONE_SURROGATE",
						path: filePath,
					});
				default:
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									ok: true,
									path: filePath,
									replacements: outcome.replacements,
									size: outcome.size,
								}),
							},
						],
					};
			}
		}, fileToolError),
	);

	server.tool(
		"sandbox_delete",
		"Delete a sandbox and all its files",
		{ id: z.string() },
		withWorkerToolContext(async (args) => {
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
		}, sandboxDeleteToolError),
	);

	server.tool(
		"sandbox_update",
		"Turn runtime flags on or off for an existing sandbox: python, javascript, network. Omitted flags keep their value. The next bash_exec runs with the new flags; files are untouched.",
		{
			id: z.string(),
			python: z.boolean().optional(),
			javascript: z.boolean().optional(),
			network: z.boolean().optional().describe("Grant outbound HTTPS (enables curl + git clone/fetch/push)"),
		},
		withWorkerToolContext(async ({ id, ...runtime }) => {
			if (Object.values(runtime).every((flag) => flag === undefined)) {
				return fail("Set at least one of python, javascript, network");
			}
			const meta = await withOwnedSessionOrRehydrate(sessionManager, tenant, id, owner, (session) =>
				sessionManager.updateSandboxRuntime(session, runtime),
			);
			const result = { id, python: meta.python, javascript: meta.javascript, network: meta.network };
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
		}, sandboxDeleteToolError),
	);

	const bashExecDescription = [
		"Execute a bash script in a sandbox. Returns stdout, stderr, and exitCode.",
		"",
		"ATOMICITY: the sandbox lock is held for the entire duration of this call.",
		"All reads, computes, and writes that must be atomic MUST be in one script.",
		"Two separate bash_exec calls are two separate lock acquisitions — another",
		"caller can slip in between them. Example of the race:",
		"  call 1: cat balance.txt  → returns 100",
		"  [another agent writes 0 here]",
		"  call 2: echo 50 > balance.txt  → silently overwrites the other agent's write",
		"Fix: bundle read + compute + write into one script string.",
		"",
		"Supported: cat, echo, ls, find, mkdir, rm, mv, cp, touch, chmod, stat, grep, sed, awk,",
		"sort, wc, head, tail, cut, tr, uniq, diff, pipes (|), redirects (>, >>, <),",
		"environment variables, conditionals (if/else), loops (for/while), functions, arithmetic,",
		"base64, md5sum, sha256sum, tar, gzip, jq, yq, xan, sqlite3.",
		"",
		"Network: sandboxes are air-gapped by default. With network:true (sandbox_create or",
		"sandbox_update), curl and outbound git clone/fetch/push over HTTPS are available. wget is not supported.",
		"",
		"NOT supported: apt/pip/npm (no package managers),",
		"vi/vim/nano (no interactive), background jobs (&), kill/ps/top (no process control),",
		"/proc /sys /dev (no special filesystems), ln -s (symlinks off by default),",
		"gcc/make/rustc (no compilers).",
		"",
		"Optional runtimes (only with python:true or javascript:true, set by sandbox_create or sandbox_update):",
		"- python3 / python — CPython WASM, stdlib only (no pip, no network, no os.system).",
		"  Concurrent python3 executions across the server are capped to prevent OOM; excess",
		"  scripts queue until a slot frees.",
		"- js-exec / node — QuickJS WASM. TypeScript supported. No npm. fetch is available",
		"  only with network:true.",
	].join("\n");

	server.tool(
		"bash_exec",
		bashExecDescription,
		{
			id: z.string(),
			script: z.string(),
			timeout: z.number().int().positive().optional(),
			debug: z.boolean().optional().describe("When true, prepends 'set -x' for command-level tracing in stderr"),
			readOnly: z
				.boolean()
				.optional()
				.describe(
					"When true, runs the script in read-only mode: parallel reads are unblocked across calls (no exclusive lock) and any mutating filesystem op is rejected with EREADONLY at the offending command.",
				),
		},
		withWorkerToolContext(async (args, extra) => {
			const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const scriptToRun = args.debug ? `set -x\n${args.script}` : args.script;
			const runner = args.readOnly ? withOwnedSessionRead : withOwnedSessionOrRehydrate;

			const result = await workerRequestContext.run(
				{
					bytes: retainedInputBytes(args) + (args.debug ? retainedInputBytes(scriptToRun) : 0),
					signal: extra?.signal,
				},
				() =>
					runner(sessionManager, tenant, args.id, owner, async (session) => {
						const controller = new AbortController();
						const lostSignal = sessionLeaseSignal();
						let timedOut = false;
						const startMs = Date.now();

						const timer = setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeoutMs);

						// Audit L4: abort the in-flight exec on MCP client disconnect rather
						// than running to the full timeout.
						const onDisconnect = (): void => controller.abort();
						extra.signal.addEventListener("abort", onDisconnect, { once: true });
						if (extra.signal.aborted) controller.abort();

						try {
							const execResult = await sessionManager.execWithRuntimeThrottle(session, scriptToRun, {
								signal: lostSignal ? AbortSignal.any([controller.signal, lostSignal]) : controller.signal,
							});
							clearTimeout(timer);
							extra.signal.removeEventListener("abort", onDisconnect);
							if (
								timedOut &&
								controller.signal.aborted &&
								execResult.executionAborted === true &&
								!lostSignal?.aborted
							) {
								return {
									stdout: "",
									stderr: "timeout",
									exitCode: -1,
									exitSignal: null as string | null,
									timedOut: true,
									durationMs: Date.now() - startMs,
								};
							}
							return {
								stdout: execResult.stdout,
								stderr: execResult.stderr,
								exitCode: execResult.exitCode,
								exitSignal: null as string | null,
								timedOut: false,
								durationMs: Date.now() - startMs,
							};
						} catch (e) {
							clearTimeout(timer);
							extra.signal.removeEventListener("abort", onDisconnect);
							if (timedOut && ((e as Error)?.name === "AbortError" || (e as { code?: string })?.code === undefined)) {
								return {
									stdout: "",
									stderr: "timeout",
									exitCode: -1,
									exitSignal: null as string | null,
									timedOut: true,
									durationMs: Date.now() - startMs,
								};
							}
							throw e;
						}
					}),
			);

			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		}, executionToolError),
	);

	server.tool(
		"bash_exec_batch",
		[
			"Execute multiple bash scripts in a sandbox within a single request.",
			"Collapses N round-trips into 1 — ideal for exploration (find, grep, cat).",
			"",
			"When readOnly:true → scripts run IN PARALLEL (bounded fan-out, ordered results).",
			"When readOnly:false or omitted → scripts run SEQUENTIALLY and share shell state.",
			"",
			"Each result includes stdout, stderr, exitCode. A single timeout (ms) budget covers all scripts;",
			"set `timeout` to override the default. Remaining scripts get error: 'timeout' if the budget is exceeded.",
			"Max 50 scripts per batch.",
			"",
			"ATOMICITY (write path): the lock is acquired once for the entire batch — all scripts are atomic",
			"relative to other callers. If your logic requires reading state in one script and",
			"writing based on it in another, that is safe within a single batch call.",
			"It is NOT safe across two separate bash_exec or bash_exec_batch calls.",
		].join("\n"),
		{
			id: z.string(),
			scripts: z
				.array(z.object({ id: z.string(), script: z.string() }))
				.min(1)
				.max(50),
			timeout: z.number().int().positive().optional(),
			readOnly: z
				.boolean()
				.optional()
				.describe(
					"When true, runs all scripts in the batch in read-only mode: parallel reads are unblocked across calls and any mutating filesystem op is rejected with EREADONLY at the offending command.",
				),
		},
		withWorkerToolContext(
			async (args, extra) => {
				const totalTimeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
				const runner = args.readOnly ? withOwnedSessionRead : withOwnedSessionOrRehydrate;

				const disconnectController = new AbortController();
				const onDisconnect = () => disconnectController.abort();
				extra.signal.addEventListener("abort", onDisconnect, { once: true });
				if (extra.signal.aborted) disconnectController.abort();

				try {
					const results = await runner(sessionManager, tenant, args.id, owner, async (session) => {
						const lostSignal = sessionLeaseSignal();
						return executeBatch(
							sessionManager,
							session,
							args.scripts,
							totalTimeoutMs,
							lostSignal ? AbortSignal.any([disconnectController.signal, lostSignal]) : disconnectController.signal,
						);
					});

					return {
						content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
					};
				} finally {
					extra.signal.removeEventListener("abort", onDisconnect);
				}
			},
			(error, args) => batchToolError(error, args.id, tenant),
		),
	);

	server.tool(
		"fs_ingest",
		[
			"Seed files into a sandbox in a single bulk database insert.",
			"",
			"DEFAULT: use `paths` for any file that already exists on disk.",
			"EXCEPTION: use `files` only for small, dynamically generated content",
			"(e.g. a config snippet you just constructed) that has no host path.",
			"",
			"`paths` — HOST FILESYSTEM PATHS (default, fast, zero token cost):",
			"   { relativePath: absoluteHostPath }",
			"   The server reads the bytes directly from the host filesystem.",
			"   You emit only path strings — no file content ever appears in your output.",
			"   Use this for regular files on disk. Ingest and worker-message byte limits apply.",
			'   Example: { "src/app.ts": "/Users/me/project/src/app.ts" }',
			"",
			"`files` — INLINE BASE64 (small generated content only):",
			"   { relativePath: base64EncodedBytes }",
			"   Every byte of file content becomes output tokens — extremely slow for",
			"   anything larger than a few KB. Only use this when the content does not",
			"   exist on disk and you are generating it on the fly.",
			'   For text: Buffer.from(text, "utf-8").toString("base64").',
			"",
			"Both params can be combined in one call. At least one must be non-empty.",
			"",
			"Keys MUST be relative paths (no leading `/`, no `..`, no null bytes).",
			"The server joins each key onto `basePath` to form the sandbox path.",
			"Missing parent directories are created automatically.",
			"",
			"`basePath`: absolute root inside the sandbox (default `/home/user`).",
			"Returns `{ ok: true, count: N }` on success, `{ ok: false, error }` on failure.",
		].join("\n"),
		{
			id: z.string().describe("Sandbox id returned by sandbox_create."),
			basePath: z
				.string()
				.optional()
				.describe("Absolute root path inside the sandbox to anchor relative file keys. Default: /home/user"),
			paths: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"DEFAULT. Map of relativePath → absolute host path. Server reads bytes directly — use for all files that exist on disk.",
				),
			files: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"EXCEPTION: small generated content only. Map of relativePath → base64 bytes. Avoid for anything >a few KB — every byte costs output tokens.",
				),
		},
		withWorkerToolContext(
			async (args, extra) => {
				const metadata =
					(await sessionManager.getSandboxMeta(tenant, args.id)) ?? sessionManager.getSession(tenant, args.id);
				if (metadata === undefined) throw Object.assign(new Error("sandbox not found"), { code: "ENOENT" });
				if (!isOwnedBy(metadata.owner, owner)) throw createForbiddenError();
				const prepared = await prepareBulkIngestPayload({
					basePath: args.basePath ?? "/home/user",
					files: args.files,
					paths: args.paths,
				});
				if (!prepared.ok) return fail(prepared.errors.join("; "));
				const { payload } = prepared;
				sessionManager.assertWorkerMessageBudget(
					{ kind: "bulkIngest", files: payload.bulkFiles },
					payload.contentBytes,
				);
				const result = await workerRequestContext.run(
					{
						bytes: retainedInputBytes(args) + retainedInputBytes(payload.bulkFiles) + payload.contentBytes,
						signal: extra?.signal,
					},
					() =>
						withOwnedSessionOrRehydrate(sessionManager, tenant, args.id, owner, async (session) => {
							const fs = session.fs as ICoherentFs;
							if (typeof fs.bulkIngest !== "function") {
								throw Object.assign(new Error("bulkIngest not supported by this fs backend"), { code: "ENOTSUP" });
							}
							const built = await payload.materialize(extra?.signal);
							if (!built.ok) return { ok: false as const, error: built.errors.join("; ") };
							await fs.bulkIngest(built.bulkFiles);
							return { ok: true as const, count: built.bulkFiles.length };
						}),
				);

				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			},
			(error, args) => ingestToolError(error, args.id, tenant),
		),
	);

	server.tool(
		"fs_export",
		"Download files from sandbox as JSON map",
		{
			id: z.string(),
			basePath: z.string().optional(),
		},
		withWorkerToolContext(async (args) => {
			const basePath = args.basePath ?? "/home/user";
			// `ignoreBOM` for the same reason as file_read: an export is re-imported verbatim.
			const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

			const { files, errors } = await withOwnedSessionOrRehydrate(
				sessionManager,
				tenant,
				args.id,
				owner,
				async (session) => {
					const allPaths = await sessionManager.getSessionPaths(session);
					const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
					const result: Record<string, string> = Object.create(null);
					const readErrors: string[] = [];

					const candidates = allPaths.filter((p) => p.startsWith(prefix));
					if (candidates.length > MAX_EXPORT_FILES) {
						throw Object.assign(new Error(`export exceeds file limit (${MAX_EXPORT_FILES})`), {
							code: "EEXPORT_TOO_LARGE",
						});
					}
					let totalBytes = 0;
					// Read in bounded-concurrency batches with a running byte cap so a large
					// sandbox can't open every file at once or blow up memory (audit H11).
					for (let i = 0; i < candidates.length; i += MAX_EXPORT_CONCURRENCY) {
						const batch = candidates.slice(i, i + MAX_EXPORT_CONCURRENCY);
						await Promise.all(
							batch.map(async (absPath) => {
								try {
									const buf = await session.fs.readFileBuffer(absPath);
									totalBytes += buf.byteLength;
									if (totalBytes > MAX_EXPORT_BYTES) {
										throw Object.assign(new Error(`export exceeds byte limit (${MAX_EXPORT_BYTES})`), {
											code: "EEXPORT_TOO_LARGE",
										});
									}
									const relativePath = absPath.slice(prefix.length);
									try {
										result[relativePath] = utf8Decoder.decode(buf);
									} catch {
										result[relativePath] =
											`data:application/octet-stream;base64,${Buffer.from(buf).toString("base64")}`;
									}
								} catch (e) {
									const code = (e as Error & { code?: string }).code;
									if (code === "EEXPORT_TOO_LARGE") throw e;
									// EISDIR is expected — directories cannot be read as files
									if (code !== "EISDIR") {
										readErrors.push(absPath);
									}
								}
							}),
						);
					}

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
		}, exportToolError),
	);
}
