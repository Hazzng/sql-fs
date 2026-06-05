import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/index.js";
import { baseUrl, jsonResponse, makeFetch } from "./test-utils.js";

describe("TypeScript SQL-FS SDK authentication", () => {
	it("bootstraps auth_secret lazily", async () => {
		const { fetchMock, captured } = makeFetch([
			jsonResponse(201, { token: "minted-jwt", sub: "alice", expiresAt: null }),
		]);
		const client = new Client({ baseUrl, authSecret: "s3cret", sub: "alice", maxRetries: 0, fetch: fetchMock });

		await expect(client.getToken()).resolves.toBe("minted-jwt");
		expect(captured[0]?.url).toBe(`${baseUrl}/v1/auth/bootstrap`);
		expect(captured[0]?.body).toEqual({ sub: "alice", expiresIn: "30d" });
		expect(new Headers(captured[0]?.init.headers).get("X-Auth-Secret")).toBe("s3cret");
	});

	it("deduplicates concurrent auth_secret bootstraps", async () => {
		let releaseBootstrap: (() => void) | undefined;
		const bootstrapGate = new Promise<void>((resolve) => {
			releaseBootstrap = resolve;
		});
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/v1/auth/bootstrap")) {
				await bootstrapGate;
				return jsonResponse(201, { token: "shared-jwt", sub: "alice", expiresAt: null });
			}
			return jsonResponse(200, { sandboxes: [] });
		});
		const client = new Client({ baseUrl, authSecret: "s3cret", sub: "alice", maxRetries: 0, fetch: fetchMock });

		const operations = Array.from({ length: 6 }, () => client.sandboxes.list());
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		releaseBootstrap?.();
		await expect(Promise.all(operations)).resolves.toEqual([[], [], [], [], [], []]);

		const bootstrapCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1/auth/bootstrap"));
		expect(bootstrapCalls).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});

	it("uses admin endpoint for admin_secret bootstrap", async () => {
		const { fetchMock, captured } = makeFetch([jsonResponse(201, { token: "admin-jwt", sub: "root" })]);
		const client = new Client({
			baseUrl,
			token: "caller-jwt",
			adminSecret: "adm",
			sub: "root",
			maxRetries: 0,
			fetch: fetchMock,
		});

		await expect(client.getToken()).resolves.toBe("admin-jwt");
		expect(captured[0]?.url).toBe(`${baseUrl}/v1/auth/admin`);
		expect(new Headers(captured[0]?.init.headers).get("X-Admin-Secret")).toBe("adm");
		expect(new Headers(captured[0]?.init.headers).get("Authorization")).toBe("Bearer caller-jwt");
	});

	it("requires credentials and sub for secret bootstrap", () => {
		expect(() => new Client({ baseUrl })).toThrow("Provide one of");
		expect(() => new Client({ baseUrl, authSecret: "x" })).toThrow("sub is required");
		expect(() => new Client({ baseUrl, adminSecret: "x", sub: "root" })).toThrow("token is required");
		expect(
			() => new Client({ baseUrl, token: "caller", authSecret: "auth", adminSecret: "admin", sub: "root" }),
		).toThrow("mutually exclusive");
	});
});
