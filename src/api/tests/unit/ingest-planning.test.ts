import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBulkIngestPayload, prepareBulkIngestPayload } from "../../ingest-manifest.js";
import { assertWorkerMessageBudget } from "../../worker-owner/message-budget.js";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(name: string, content: Uint8Array) {
	const directory = await mkdtemp(join(tmpdir(), "sql-fs-ingest-plan-"));
	directories.push(directory);
	const path = join(directory, name);
	await writeFile(path, content);
	return { path, directory };
}

describe("bounded ingest planning", () => {
	it("preflights metadata plus exact payload bytes and retains mixed binary files", async () => {
		const bytes = Uint8Array.from([0, 0xff, 0xc3, 0xb6, 10]);
		const { path } = await fixture("host", bytes);
		const prepared = await prepareBulkIngestPayload({
			basePath: "/home/user",
			files: { inline: Buffer.from(bytes).toString("base64") },
			paths: { nested: path },
		});
		if (!prepared.ok) throw new Error(prepared.errors.join("; "));
		expect(prepared.payload.contentBytes).toBe(10);
		expect(prepared.payload.bulkFiles.every((file) => file.content.byteLength === 0)).toBe(true);
		const built = await prepared.payload.materialize();
		if (!built.ok) throw new Error(built.errors.join("; "));
		for (const file of built.bulkFiles) expect(Array.from(file.content)).toEqual(Array.from(bytes));
		for (const limit of [100, 200, 300, 400, 500]) {
			const outcome = (operation: () => void) => {
				try {
					operation();
					return "accepted";
				} catch (error) {
					return (error as { code?: string }).code;
				}
			};
			expect(
				outcome(() =>
					assertWorkerMessageBudget(
						{ kind: "bulkIngest", files: prepared.payload.bulkFiles },
						limit,
						prepared.payload.contentBytes,
					),
				),
			).toEqual(outcome(() => assertWorkerMessageBudget({ kind: "bulkIngest", files: built.bulkFiles }, limit)));
		}
	});

	it.each(["grow", "shrink"])("refuses a host file that changes size after planning: %s", async (change) => {
		const { path } = await fixture("changing", Uint8Array.from([1, 2, 3]));
		const prepared = await prepareBulkIngestPayload({ basePath: "/home/user", paths: { file: path } });
		if (!prepared.ok) throw new Error(prepared.errors.join("; "));
		if (change === "grow") await appendFile(path, Uint8Array.from([4]));
		else await writeFile(path, Uint8Array.from([1]));
		expect(await prepared.payload.materialize()).toEqual({ ok: false, errors: ["unreadable host paths: file"] });
	});

	it("refuses non-regular paths before opening them", async () => {
		const { directory } = await fixture("file", new Uint8Array(0));
		expect(await prepareBulkIngestPayload({ basePath: "/home/user", paths: { file: directory } })).toEqual({
			ok: false,
			errors: ["unreadable host paths: file"],
		});
	});

	it("detects growth during a read without reading past the planned bytes and one probe byte", async () => {
		const { path } = await fixture("growing", Uint8Array.from([1, 2, 3]));
		const prepared = await prepareBulkIngestPayload({ basePath: "/home/user", paths: { file: path } });
		if (!prepared.ok) throw new Error(prepared.errors.join("; "));
		const handle = await open(path, "r");
		const prototype = Object.getPrototypeOf(handle);
		const original = prototype.read;
		await handle.close();
		let readBytes = 0;
		vi.spyOn(prototype, "read").mockImplementation(async function (this: typeof handle, ...args: unknown[]) {
			const result = await original.apply(this, args);
			readBytes += result.bytesRead;
			if (readBytes === 3) await appendFile(path, Uint8Array.from([4, 5, 6]));
			return result;
		});
		expect(await prepared.payload.materialize()).toEqual({ ok: false, errors: ["unreadable host paths: file"] });
		expect(readBytes).toBe(4);
	});

	it("retains empty-file and empty HTTP manifest behavior", async () => {
		const { path } = await fixture("empty", new Uint8Array(0));
		const built = await buildBulkIngestPayload({ basePath: "/home/user", paths: { empty: path } });
		expect(built).toEqual({
			ok: true,
			bulkFiles: [{ path: "/home/user/empty", content: new Uint8Array(0), mode: 0o644 }],
		});
		expect(await buildBulkIngestPayload({ basePath: "/home/user", files: {}, allowEmpty: true })).toEqual({
			ok: true,
			bulkFiles: [],
		});
	});

	it("cancels before content reads without losing subsequent healthy use", async () => {
		const { path } = await fixture("cancelled", Uint8Array.from([5]));
		const prepared = await prepareBulkIngestPayload({ basePath: "/home/user", paths: { file: path } });
		if (!prepared.ok) throw new Error(prepared.errors.join("; "));
		await expect(prepared.payload.materialize(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(await prepared.payload.materialize()).toMatchObject({ ok: true });
	});

	it("does not allocate contents for an oversized sparse host file", async () => {
		const { path } = await fixture("large", new Uint8Array(0));
		const handle = await open(path, "r+");
		try {
			await handle.truncate(65 * 1024 * 1024);
		} finally {
			await handle.close();
		}
		const prepared = await prepareBulkIngestPayload({ basePath: "/home/user", paths: { large: path } });
		if (!prepared.ok) throw new Error(prepared.errors.join("; "));
		expect(prepared.payload.contentBytes).toBe(65 * 1024 * 1024);
		expect(() =>
			assertWorkerMessageBudget(
				{ kind: "bulkIngest", files: prepared.payload.bulkFiles },
				64 * 1024 * 1024,
				prepared.payload.contentBytes,
			),
		).toThrow("EFBIG");
	});
});
