import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { retainIngressWork } from "../ingress-admission.js";
import { retainedInputBytes } from "../lib/request-input.js";
import { workerRequestContext } from "../worker-owner/request-context.js";
import { workerToolError } from "./worker-errors.js";

export function withWorkerToolContext<Args, Extra extends { signal: AbortSignal }>(
	handler: (args: Args, extra: Extra) => Promise<CallToolResult>,
	onError: (error: unknown, args: Args) => CallToolResult,
): (args: Args, extra: Extra) => Promise<CallToolResult> {
	return retainIngressWork(async (args, extra) => {
		try {
			return await workerRequestContext.run({ bytes: retainedInputBytes(args), signal: extra?.signal }, () =>
				handler(args, extra),
			);
		} catch (error) {
			return workerToolError(error) ?? onError(error, args);
		}
	});
}
