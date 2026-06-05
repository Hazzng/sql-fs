import { vi } from "vitest";
import { Client } from "../src/index.js";

export const baseUrl = "https://api.test";

export interface CapturedRequest {
	url: string;
	init: RequestInit;
	body?: unknown;
}

export function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

export function textResponse(status: number, body = "", headers?: HeadersInit): Response {
	if (status === 204 || status === 205 || status === 304) {
		return new Response(null, { status, headers });
	}
	return new Response(body, { status, headers });
}

export function makeFetch(responses: Array<Response | Error>) {
	const captured: CapturedRequest[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const request: CapturedRequest = { url: String(input), init: init ?? {} };
		if (typeof init?.body === "string") {
			request.body = JSON.parse(init.body);
		} else if (init?.body instanceof Uint8Array) {
			request.body = init.body;
		}
		captured.push(request);
		const response = responses.shift();
		if (!response) {
			throw new Error("unexpected fetch call");
		}
		if (response instanceof Error) {
			throw response;
		}
		return response;
	});
	return { fetchMock, captured };
}

export function makeClient(
	fetchImpl: typeof fetch,
	overrides: Partial<ConstructorParameters<typeof Client>[0]> = {},
): Client {
	return new Client({ baseUrl, token: "t.k.n", maxRetries: 0, fetch: fetchImpl, ...overrides });
}
