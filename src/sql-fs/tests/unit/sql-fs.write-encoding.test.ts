import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";

const UTF8_TEXT = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a]);

describe("SqlFs honours the write encoding", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs();
		await env.fs.writeFile("/home/user/src.txt", UTF8_TEXT);
	});

	it("copies a non-ASCII file byte for byte through cat >", async () => {
		await env.bash.exec("cat /home/user/src.txt > /home/user/dst.txt");

		expect(await env.fs.readFileBuffer("/home/user/dst.txt")).toEqual(UTF8_TEXT);
	});

	it("appends a non-ASCII file byte for byte through cat >>", async () => {
		const prefix = new TextEncoder().encode("pre\n");
		await env.fs.writeFile("/home/user/dst.txt", prefix);
		vi.mocked(env.probe.dialect.getBlob).mockResolvedValueOnce(prefix);
		await env.bash.exec("cat /home/user/src.txt >> /home/user/dst.txt");

		expect(await env.fs.readFileBuffer("/home/user/dst.txt")).toEqual(
			new Uint8Array([0x70, 0x72, 0x65, 0x0a, ...UTF8_TEXT]),
		);
	});

	it("stores a binary string as one byte per character", async () => {
		await env.fs.writeFile("/home/user/b.bin", "\xff\x00\x80", "binary");

		expect(await env.fs.readFileBuffer("/home/user/b.bin")).toEqual(new Uint8Array([0xff, 0x00, 0x80]));
	});

	it("still UTF-8 encodes a string written without an encoding", async () => {
		await env.fs.writeFile("/home/user/u.txt", "é");

		expect(await env.fs.readFileBuffer("/home/user/u.txt")).toEqual(new Uint8Array([0xc3, 0xa9]));
	});
});
