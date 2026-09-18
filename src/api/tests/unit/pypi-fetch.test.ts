import { describe, expect, it } from "vitest";
import { createPypiFetch } from "../../commands/pypi-fetch.js";

const encoder = new TextEncoder();

function streamingResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers });
}

describe("pip-scoped PyPI fetch", () => {
	it("returns the body of an allowed GET", async () => {
		const fetchImpl = async (): Promise<Response> =>
			new Response(encoder.encode("{}"), { status: 200, headers: { "content-type": "application/json" } });
		const fetch = createPypiFetch({ maxResponseSize: 1024, timeoutMs: 1000, fetchImpl });
		const result = await fetch("https://pypi.org/pypi/demo/json");
		expect(result.status).toBe(200);
		expect(new TextDecoder().decode(result.body)).toBe("{}");
		expect(result.headers["content-type"]).toBe("application/json");
	});

	it("rejects a response whose content-length exceeds the cap before reading it", async () => {
		let bodyRead = false;
		const fetchImpl = async (): Promise<Response> => {
			bodyRead = true;
			return new Response(encoder.encode("x".repeat(100)), {
				status: 200,
				headers: { "content-length": "100" },
			});
		};
		const fetch = createPypiFetch({ maxResponseSize: 10, timeoutMs: 1000, fetchImpl });
		await expect(fetch("https://pypi.org/pypi/demo/json")).rejects.toThrowError(
			"response exceeds the maximum allowed size of 10 bytes",
		);
		expect(bodyRead).toBe(true);
	});

	it("rejects a response that exceeds the cap mid-stream without a content-length", async () => {
		const fetchImpl = async (): Promise<Response> =>
			streamingResponse([encoder.encode("x".repeat(8)), encoder.encode("x".repeat(8))]);
		const fetch = createPypiFetch({ maxResponseSize: 10, timeoutMs: 1000, fetchImpl });
		const error = await fetch("https://files.pythonhosted.org/demo.whl").catch((cause: Error) => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("ResponseTooLargeError");
	});

	it("aborts the request when the timeout elapses", async () => {
		const fetchImpl = (_url: string | Request | URL, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
			});
		const fetch = createPypiFetch({ maxResponseSize: 1024, timeoutMs: 5, fetchImpl });
		await expect(fetch("https://pypi.org/pypi/demo/json")).rejects.toThrowError("aborted by signal");
	});

	it("aborts the request when the caller's signal fires", async () => {
		const controller = new AbortController();
		const fetchImpl = (_url: string | Request | URL, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
			});
		const fetch = createPypiFetch({ maxResponseSize: 1024, timeoutMs: 60_000, fetchImpl });
		const pending = fetch("https://pypi.org/pypi/demo/json", { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrowError("aborted by signal");
	});

	it("refuses a host outside PyPI", async () => {
		const fetch = createPypiFetch({
			maxResponseSize: 1024,
			timeoutMs: 1000,
			fetchImpl: async () => new Response("no"),
		});
		await expect(fetch("https://evil.example.com/demo.whl")).rejects.toThrowError(
			"pip fetch refuses the host 'evil.example.com'",
		);
	});

	it("refuses http, credentials and non-GET methods", async () => {
		const fetch = createPypiFetch({
			maxResponseSize: 1024,
			timeoutMs: 1000,
			fetchImpl: async () => new Response("no"),
		});
		await expect(fetch("http://pypi.org/pypi/demo/json")).rejects.toThrowError("permits https URLs only");
		await expect(fetch("https://user:pw@pypi.org/pypi/demo/json")).rejects.toThrowError(
			"refuses URLs carrying credentials",
		);
		await expect(fetch("https://pypi.org/pypi/demo/json", { method: "POST" })).rejects.toThrowError(
			"permits GET requests only",
		);
	});

	it("does not follow a redirect; it returns the hop to the caller", async () => {
		const requested: string[] = [];
		const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requested.push(String(url));
			expect(init?.redirect).toBe("manual");
			return new Response(null, {
				status: 302,
				headers: { location: "https://files.pythonhosted.org/elsewhere.whl" },
			});
		};
		const fetch = createPypiFetch({ maxResponseSize: 1024, timeoutMs: 1000, fetchImpl });
		const result = await fetch("https://pypi.org/pypi/demo/json");
		expect(result.status).toBe(302);
		expect(result.headers.location).toBe("https://files.pythonhosted.org/elsewhere.whl");
		expect(requested).toEqual(["https://pypi.org/pypi/demo/json"]);
	});
});
