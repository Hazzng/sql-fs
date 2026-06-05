import { describe, expect, it } from "vitest";
import { type FileContent, ValidationError } from "../src/index.js";
import { baseUrl, jsonResponse, makeClient, makeFetch, textResponse } from "./test-utils.js";

describe("TypeScript SQL-FS SDK files", () => {
	it("reads, writes, deletes, mkdirs, and trees files", async () => {
		const stat = JSON.stringify({ kind: "file", mode: 0o644, size: 5, mtime: "t" });
		const { fetchMock, captured } = makeFetch([
			textResponse(200, "hello", { "X-FS-Stat": stat, "Content-Type": "text/plain" }),
			textResponse(204),
			textResponse(204),
			textResponse(204),
			jsonResponse(200, [
				{ path: "/a", kind: "dir", size: 0, mtime: "t" },
				{ path: "/a/b.txt", kind: "file", size: 5, mtime: "t" },
			]),
		]);
		const sb = makeClient(fetchMock).sandboxes.attach("sb");

		const read = await sb.fs.read("/home/user/x.txt");
		expect(read.text()).toBe("hello");
		expect(read.stat?.size).toBe(5);

		await sb.fs.write("/a/b.txt", "hello");
		expect(captured[1]?.url).toBe(`${baseUrl}/v1/sandboxes/sb/files/a/b.txt`);
		expect(new Headers(captured[1]?.init.headers).get("Content-Type")).toBe("application/octet-stream");

		await sb.fs.delete("/dir", { recursive: true });
		expect(captured[2]?.url).toBe(`${baseUrl}/v1/sandboxes/sb/files/dir?recursive=true`);

		await sb.fs.mkdir("/a/b/c", { recursive: true });
		expect(captured[3]?.body).toEqual({ path: "/a/b/c", recursive: true });

		const entries = await sb.fs.tree({ prefix: "/a", depth: 2 });
		expect(entries.map((entry) => entry.kind)).toEqual(["dir", "file"]);
		expect(captured[4]?.url).toBe(`${baseUrl}/v1/sandboxes/sb/tree?prefix=%2Fa&depth=2`);
	});

	it("ingests files as base64 and enforces max file size before sending", async () => {
		const { fetchMock, captured } = makeFetch([jsonResponse(200, { count: 1 })]);
		const sb = makeClient(fetchMock).sandboxes.attach("sb");
		const files = JSON.parse('{"a.txt":"hello","b.bin":"binary","__proto__":"safe"}') as Record<string, FileContent>;
		files["b.bin"] = new Uint8Array([0, 1]);

		await expect(sb.ingestFiles(files, { basePath: "/home/user/p" })).resolves.toEqual({ count: 1 });
		const sentBody = captured[0]?.body as { basePath: string; files: Record<string, string> };
		expect(sentBody.basePath).toBe("/home/user/p");
		expect(Object.entries(sentBody.files)).toEqual([
			["a.txt", "aGVsbG8="],
			["b.bin", "AAE="],
			["__proto__", "c2FmZQ=="],
		]);
		const sentFiles = sentBody.files;
		expect(Object.hasOwn(sentFiles, "__proto__")).toBe(true);

		const blocked = makeFetch([jsonResponse(200, {})]);
		const limited = makeClient(blocked.fetchMock, { maxFileSize: 3 }).sandboxes.attach("sb");
		await expect(limited.fs.write("/too-big.txt", "hello")).rejects.toMatchObject(
			new ValidationError("file exceeds maxFileSize: /too-big.txt (5 bytes > 3 limit)", {
				code: "EFILE_TOO_LARGE",
				details: ["/too-big.txt (5 bytes > 3 limit)"],
			}),
		);
		expect(blocked.fetchMock).not.toHaveBeenCalled();
	});
});
