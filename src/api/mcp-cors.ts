/**
 * CORS for /mcp so MCP Inspector (browser on another port) can call the API.
 * Browsers hide response headers from JS unless listed in Access-Control-Expose-Headers;
 * the MCP Streamable HTTP client reads `mcp-session-id` from responses.
 */

function allowOriginHeader(origin: string | undefined): string {
	if (origin === undefined || origin === "") {
		return "*";
	}
	try {
		const hostname = new URL(origin).hostname;
		if (hostname === "localhost" || hostname === "127.0.0.1") {
			return origin;
		}
	} catch {
		/* ignore */
	}
	return "*";
}

const MCP_EXPOSE_HEADERS = "mcp-session-id, mcp-protocol-version, content-type";

/** Adds CORS headers to any /mcp Response (including auth errors). */
export function withMcpCors(req: Request, res: Response): Response {
	const headers = new Headers(res.headers);
	const allow = allowOriginHeader(req.headers.get("origin") ?? undefined);
	headers.set("Access-Control-Allow-Origin", allow);
	if (allow !== "*") {
		headers.append("Vary", "Origin");
	}
	headers.set("Access-Control-Expose-Headers", MCP_EXPOSE_HEADERS);
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Preflight for browser MCP clients (e.g. Inspector UI). No JWT required. */
export function mcpOptionsResponse(req: Request): Response {
	const allow = allowOriginHeader(req.headers.get("origin") ?? undefined);
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": allow,
			...(allow !== "*" ? { Vary: "Origin" } : {}),
			"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
			"Access-Control-Allow-Headers":
				"authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
			"Access-Control-Max-Age": "86400",
		},
	});
}
