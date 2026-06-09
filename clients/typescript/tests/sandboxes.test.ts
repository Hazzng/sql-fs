import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../src/index.js";
import { jsonResponse, makeClient, makeFetch } from "./test-utils.js";

describe("TypeScript SQL-FS SDK sandboxes", () => {
	it("lists and creates sandboxes with feature flags", async () => {
		const { fetchMock, captured } = makeFetch([
			jsonResponse(200, {
				sandboxes: [
					{
						id: "id-1",
						name: "a",
						owner: "alice",
						createdAt: "2026-01-01T00:00:00Z",
						python_runtime: "stdlib",
						javascript: false,
						network: false,
					},
				],
			}),
			jsonResponse(201, {
				id: "sb-net",
				name: null,
				owner: "alice",
				createdAt: "2026-01-01T00:00:00Z",
				python_runtime: "pyodide",
				javascript: false,
				network: true,
			}),
		]);
		const client = makeClient(fetchMock);

		const sandboxes = await client.sandboxes.list();
		expect(sandboxes[0]?.id).toBe("id-1");
		expect(sandboxes[0]?.python_runtime).toBe("stdlib");
		expect(sandboxes[0]?.network).toBe(false);

		const sandbox = await client.sandboxes.create({ python_runtime: "pyodide", javascript: false, network: true });
		expect(sandbox.id).toBe("sb-net");
		expect(sandbox.record?.python_runtime).toBe("pyodide");
		expect(sandbox.record?.network).toBe(true);
		expect(captured[1]?.body).toEqual({ python_runtime: "pyodide", javascript: false, network: true });
	});

	it("sends an empty object when creating a default sandbox", async () => {
		const { fetchMock, captured } = makeFetch([
			jsonResponse(201, { id: "sb-default", owner: "alice", createdAt: "2026-01-01T00:00:00Z" }),
		]);

		await expect(makeClient(fetchMock).sandboxes.create()).resolves.toMatchObject({ id: "sb-default" });
		expect(captured[0]?.body).toEqual({});
	});

	it("maps not found and conflict errors", async () => {
		const get = makeFetch([jsonResponse(404, { error: "not_found", code: "ENOENT" })]);
		await expect(makeClient(get.fetchMock).sandboxes.get("missing")).rejects.toMatchObject(
			new NotFoundError("not_found", { code: "ENOENT", status: 404 }),
		);

		const del = makeFetch([jsonResponse(409, { error: "conflict", code: "ENOTEMPTY" })]);
		await expect(makeClient(del.fetchMock).sandboxes.attach("sb").fs.delete("/dir")).rejects.toMatchObject(
			new ConflictError("conflict", { code: "ENOTEMPTY", status: 409 }),
		);
	});
});
