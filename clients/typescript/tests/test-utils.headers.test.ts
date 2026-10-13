import { describe, expect, it } from "vitest";
import { jsonResponse } from "./test-utils.js";

describe("JSON response fixture headers", () => {
	it.each([
		{ "Retry-After": "2" },
		new Headers({ "Retry-After": "2" }),
		[["Retry-After", "2"]] satisfies [string, string][],
	])("preserves every HeadersInit representation", async (headers) => {
		const response = jsonResponse(429, { error: "busy" }, headers);
		expect(response.headers.get("Retry-After")).toBe("2");
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({ error: "busy" });
	});

	it("allows explicit content type overrides", () => {
		const response = jsonResponse(200, {}, new Headers({ "Content-Type": "application/problem+json" }));
		expect(response.headers.get("Content-Type")).toBe("application/problem+json");
	});
});
