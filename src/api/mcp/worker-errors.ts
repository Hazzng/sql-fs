import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clientSafeErrorMessage, isRetryableError } from "../errors.js";

const workerCodes: ReadonlySet<string> = new Set([
	"EEXEC_OUTCOME_UNKNOWN",
	"EEXEC_INPUT_LIMIT",
	"EWORKER_BUSY",
	"EWORKER_UNAVAILABLE",
]);

function fallbackMessage(code: string): string {
	if (code === "EEXEC_OUTCOME_UNKNOWN") return "Execution outcome is unknown";
	if (code === "EEXEC_INPUT_LIMIT") return "Execution input exceeds its byte budget";
	return "Worker unavailable";
}

export function workerToolError(error: unknown): CallToolResult | undefined {
	if (!(error instanceof Error)) return undefined;
	const code = (error as Error & { code?: string }).code;
	if (code === undefined || !workerCodes.has(code)) return undefined;
	const body = {
		ok: false,
		code,
		error: clientSafeErrorMessage(error, fallbackMessage(code)),
		retryable: isRetryableError(error),
		...(code === "EWORKER_BUSY" ? { retryAfterMs: 1000 } : {}),
	};
	return { isError: true, structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] };
}
