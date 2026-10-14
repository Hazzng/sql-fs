import { describe, expect, it } from "vitest";
import { jsonResponse, makeClient, makeFetch } from "./test-utils.js";

describe("TypeScript SQL-FS SDK base URL", () => {
	it("strips every trailing slash from baseUrl before building request URLs", async () => {
		const { fetchMock, captured } = makeFetch([jsonResponse(200, { sandboxes: [] })]);
		const client = makeClient(fetchMock, { baseUrl: "https://api.test/prefix///" });

		await client.sandboxes.list();

		expect(captured[0]?.url).toBe("https://api.test/prefix/v1/sandboxes");
	});

	it("keeps interior slashes when baseUrl has no trailing slash", async () => {
		const { fetchMock, captured } = makeFetch([jsonResponse(200, { sandboxes: [] })]);
		const client = makeClient(fetchMock, { baseUrl: "https://api.test//prefix" });

		await client.sandboxes.list();

		expect(captured[0]?.url).toBe("https://api.test//prefix/v1/sandboxes");
	});
});
