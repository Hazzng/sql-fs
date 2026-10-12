import { describe, expect, it } from "vitest";
import { AuthError, Client, ConflictError, NotFoundError, ServerError, ValidationError } from "../src/index.js";
import { baseUrl, jsonResponse, makeFetch, textResponse } from "./test-utils.js";

describe("TypeScript SQL-FS SDK execution error delivery", () => {
	it.each([
		["ENOENT", 404, NotFoundError],
		["EEXIST", 409, ConflictError],
		["ENOTEMPTY", 409, ConflictError],
		["ESTALE", 409, ConflictError],
		["EPERM", 403, AuthError],
		["FORBIDDEN", 403, AuthError],
		["EISDIR", 400, ValidationError],
		["ENOTDIR", 400, ValidationError],
		["ELOOP", 400, ValidationError],
		["EINVAL", 400, ValidationError],
		["EREADONLY", 500, ServerError],
		["ECOHERENCE", 503, ServerError],
		["ELOCKLOST_APPLIED", 503, ServerError],
		["EDRIVERFAULT", 503, ServerError],
		["EEXEC_OUTCOME_UNKNOWN", 503, ServerError],
	] as const)("preserves canonical %s errors across HTTP and SSE without replay", async (code, status, ErrorType) => {
		const body = { error: "operation failed", code, retryable: false, details: { path: "/home/user/file" } };
		for (const delivery of ["http", "sse"] as const) {
			const response =
				delivery === "http"
					? jsonResponse(status, body)
					: textResponse(200, `event: error\ndata: ${JSON.stringify(body)}\n\n`, {
							"Content-Type": "text/event-stream",
						});
			const { fetchMock } = makeFetch([response]);
			const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: fetchMock }).sandboxes.attach("sb");
			const script = "curl -X POST https://example.test/effect";
			const consume = async () => {
				const events = [];
				for await (const event of sandbox.execStream(script, { readOnly: true })) events.push(event);
				return events;
			};
			const failure = delivery === "http" ? sandbox.exec(script, { readOnly: true, retryOn5xx: true }) : consume();

			await expect(failure).rejects.toBeInstanceOf(ErrorType);
			await expect(failure).rejects.toMatchObject({
				message: body.error,
				code,
				status,
				retryable: false,
				details: body.details,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});
});
