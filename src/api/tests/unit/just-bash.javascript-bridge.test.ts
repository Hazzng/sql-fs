import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";

const MIB = 1024 * 1024;

describe("installed just-bash JavaScript bridge", () => {
	it("reads 16 MiB of binary data across chunk boundaries within the unchanged guest heap", {
		timeout: 60000,
	}, async () => {
		const size = 16 * MIB;
		const data = Buffer.alloc(size, 0x5a);
		const positions = [0, size - 1];
		for (let boundary = MIB; boundary < size; boundary += MIB) positions.push(boundary - 1, boundary);
		const expected = positions.map((position, index) => {
			data[position] = index;
			return index;
		});
		const fs = new InMemoryFs({ "/large.bin": data });
		const originalRead = fs.readFileBuffer.bind(fs);
		const reads: string[] = [];
		fs.readFileBuffer = async (path) => {
			reads.push(path);
			return originalRead(path);
		};
		const bash = new Bash({
			fs,
			javascript: true,
			executionLimits: { maxStringLength: 64 * MIB, maxWorkerMessageBytes: 64 * MIB },
		});
		const script = `js-exec -c 'const data=require("fs").readFileSync("/large.bin"); console.log(data.length, JSON.stringify(${JSON.stringify(positions)}.map(i=>data.readUInt8(i))))'`;
		expect(await bash.exec(script)).toMatchObject({
			exitCode: 0,
			stderr: "",
			stdout: `${size} ${JSON.stringify(expected)}\n`,
		});
		expect(reads.filter((path) => path === "/large.bin")).toHaveLength(1);
		expect(await bash.exec("js-exec -c 'console.log(37)'")).toMatchObject({
			exitCode: 0,
			stdout: "37\n",
			stderr: "",
		});
	});

	it("rejects 49 MiB before reading host content and remains reusable", { timeout: 60000 }, async () => {
		const fs = new InMemoryFs({ "/large.bin": Buffer.alloc(49 * MIB) });
		const originalRead = fs.readFileBuffer.bind(fs);
		const reads: string[] = [];
		fs.readFileBuffer = async (path) => {
			reads.push(path);
			return originalRead(path);
		};
		const bash = new Bash({
			fs,
			javascript: true,
			executionLimits: { maxStringLength: 64 * MIB, maxWorkerMessageBytes: 64 * MIB },
		});
		const result = await bash.exec(`js-exec -c 'require("fs").readFileSync("/large.bin")'`);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("File exceeds");
		expect(reads).not.toContain("/large.bin");
		expect(await bash.exec("js-exec -c 'console.log(37)'")).toMatchObject({ exitCode: 0, stdout: "37\n", stderr: "" });
	});

	it("preserves UTF-8 spanning a chunk boundary, empty files, and promise reads", async () => {
		const text = `${"a".repeat(MIB - 2)}🙂€`;
		const fs = new InMemoryFs({ "/text": text, "/empty": "" });
		const bash = new Bash({
			fs,
			javascript: true,
			executionLimits: { maxStringLength: 64 * MIB, maxWorkerMessageBytes: 64 * MIB },
		});
		const result = await bash.exec(
			`js-exec -c 'const fs=require("fs"); const text=await fs.promises.readFile("/text", "utf8"); console.log(text.length, text.slice(-3), fs.readFileSync("/empty").length, fs.readFileBuffer("/text").byteLength)'`,
		);
		expect(result).toMatchObject({
			exitCode: 0,
			stderr: "",
			stdout: `${text.length} 🙂€ 0 ${Buffer.byteLength(text)}\n`,
		});
	});

	it("bounds partial reads by bridge requests and clears them before reuse", async () => {
		const fs = new InMemoryFs({ "/large.bin": Buffer.alloc(2 * MIB) });
		const bash = new Bash({
			fs,
			javascript: true,
			executionLimits: { maxWorkerMessageBytes: 64 * MIB, maxJsBridgeRequests: 1 },
		});
		const result = await bash.exec(`js-exec -c 'require("fs").readFileSync("/large.bin")'`);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("bridge request limit");
		expect(await bash.exec("js-exec -c 'console.log(37)'")).toMatchObject({ exitCode: 0, stdout: "37\n", stderr: "" });
	});

	it("cancels a pending host read and safely handles its late completion", async () => {
		let startRead!: () => void;
		let releaseRead!: () => void;
		const started = new Promise<void>((resolve) => {
			startRead = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const fs = new InMemoryFs({ "/large.bin": Buffer.alloc(2 * MIB) });
		const originalRead = fs.readFileBuffer.bind(fs);
		fs.readFileBuffer = async (path) => {
			if (path === "/large.bin") {
				startRead();
				await pending;
			}
			return originalRead(path);
		};
		const bash = new Bash({ fs, javascript: true });
		const controller = new AbortController();
		const execution = bash.exec(`js-exec -c 'require("fs").readFileSync("/large.bin")'`, { signal: controller.signal });
		await started;
		controller.abort();
		try {
			expect((await execution).exitCode).toBe(124);
		} finally {
			releaseRead();
		}
		expect(await bash.exec("js-exec -c 'console.log(37)'")).toMatchObject({ exitCode: 0, stdout: "37\n", stderr: "" });
	});

	it("keeps tolerant base64 decoding byte-compatible with Node", async () => {
		const values = [
			"",
			"A",
			"AA",
			"AAA",
			"AAAA",
			"aG☃VsbG8=ignored",
			"__--",
			"aGVs\0 bG8====tail",
			"=aGVsbG8",
			"aGVsbG8=====",
		];
		const expected = values.map((value) => Buffer.from(value, "base64").toString("hex"));
		const bash = new Bash({ javascript: true });
		const result = await bash.exec(
			`js-exec -c 'console.log(JSON.stringify(${JSON.stringify(values)}.map(value=>Buffer.from(value,"base64").toString("hex"))))'`,
		);
		expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(expected)}\n` });
	});
});
