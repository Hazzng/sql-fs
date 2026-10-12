import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clientSafeErrorMessage } from "../errors.js";

function errorCode(error: unknown): string | undefined {
	return (error as Error & { code?: string })?.code;
}

function reply(body: Record<string, unknown>): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

export function toolFailure(error: string, extra: Record<string, unknown> = {}): CallToolResult {
	return reply({ ok: false, error, ...extra });
}

export function metadataToolError(error: unknown): CallToolResult {
	return toolFailure(clientSafeErrorMessage(error, "internal error"));
}

export function fileToolError(error: unknown): CallToolResult {
	const code = errorCode(error);
	if (code === "FORBIDDEN") return toolFailure("forbidden");
	if (code === "ENOENT") return toolFailure("sandbox not found");
	return toolFailure(clientSafeErrorMessage(error));
}

export function sandboxDeleteToolError(error: unknown): CallToolResult {
	const code = errorCode(error);
	if (code === "FORBIDDEN") return toolFailure("forbidden");
	if (code === "ENOENT") return toolFailure("sandbox not found");
	return metadataToolError(error);
}

export function executionToolError(error: unknown): CallToolResult {
	const code = errorCode(error);
	if (code === "FORBIDDEN") return reply({ stdout: "", stderr: "forbidden", exitCode: 1 });
	if (code === "ENOENT") return reply({ stdout: "", stderr: "sandbox not found", exitCode: 1 });
	if (code === "EREADONLY_VIOLATION") {
		return reply({
			stdout: "",
			stderr: "EREADONLY_VIOLATION: readOnly script attempted to mutate the filesystem",
			exitCode: 1,
			code,
		});
	}
	return reply({ stdout: "", stderr: clientSafeErrorMessage(error, "internal error"), exitCode: 1 });
}

export function batchToolError(error: unknown, sandboxId: string, tenant: string): CallToolResult {
	const code = errorCode(error);
	if (code === "FORBIDDEN") return toolFailure("forbidden");
	if (code === "ENOENT") return toolFailure("sandbox not found");
	if (code === "EREADONLY_VIOLATION") {
		return toolFailure("readOnly script attempted to mutate the filesystem", { code });
	}
	console.error(
		JSON.stringify({
			event: "bash_exec_batch_failed",
			sandboxId,
			tenant,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	return toolFailure("internal error");
}

export function ingestToolError(error: unknown, sandboxId: string, tenant: string): CallToolResult {
	const code = errorCode(error);
	if (code === "FORBIDDEN") return toolFailure("forbidden");
	if (code === "ENOENT") return toolFailure("sandbox not found");
	if (code === "ENOTSUP") {
		console.error(JSON.stringify({ event: "fs_ingest_backend_unsupported", sandboxId, tenant }));
		return toolFailure("internal error");
	}
	return metadataToolError(error);
}

export function exportToolError(error: unknown): CallToolResult {
	const code = errorCode(error);
	if (code === "FORBIDDEN") return toolFailure("forbidden");
	if (code === "EEXPORT_TOO_LARGE") {
		return toolFailure("export too large; narrow with basePath", { code });
	}
	if (code === "ENOENT") return toolFailure("sandbox not found");
	return metadataToolError(error);
}
