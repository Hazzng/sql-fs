import { createHash } from "node:crypto";
import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";

const MIB = 1024 * 1024;
const BRIDGE_OVERHEAD = 4128;

describe("installed just-bash Python bridge", () => {
	it("completes a dynamically named producer-consumer Python pipeline on one filesystem", async () => {
		const bash = new Bash({ python: true });
		expect(
			await bash.exec(
				`command=py; command=\${command}thon3; $command -c 'print("pipeline")' | $command -c 'import sys; print(sys.stdin.read().upper(),end="")'`,
			),
		).toMatchObject({ exitCode: 0, stderr: "", stdout: "PIPELINE\n" });
	});
	it.each([0, BRIDGE_OVERHEAD, BRIDGE_OVERHEAD + 1, BRIDGE_OVERHEAD + 23])(
		"rejects an impossible %i byte bridge budget with its minimum configuration",
		async (messageBytes) => {
			const bash = new Bash({ python: true, executionLimits: { maxWorkerMessageBytes: messageBytes } });
			expect(await bash.exec("python3 -c 'print(37)'")).toMatchObject({
				exitCode: 1,
				stdout: "",
				stderr: "python3: worker bridge requires maxWorkerMessageBytes >= 4152 and maxStringLength >= 24\n",
			});
			expect(await bash.exec("printf healthy")).toMatchObject({ exitCode: 0, stdout: "healthy", stderr: "" });
		},
	);

	it.each([24, 25])("supports tiny Python at the %i byte bridge payload boundary", async (capacity) => {
		const bash = new Bash({ python: true, executionLimits: { maxWorkerMessageBytes: capacity + BRIDGE_OVERHEAD } });
		expect(await bash.exec("python3 -c 'print(37)'")).toMatchObject({ exitCode: 0, stdout: "37\n", stderr: "" });
		expect(await bash.exec("python3 -c 'print(38)'")).toMatchObject({ exitCode: 0, stdout: "38\n", stderr: "" });
	});

	it.each([24, 25])(
		"returns filesystem errors and preserves Unicode output at the %i byte payload minimum",
		{ timeout: 20000 },
		async (capacity) => {
			const fs = new InMemoryFs({ "/oversized": Buffer.alloc(capacity + 1) });
			const stat = fs.stat.bind(fs);
			fs.stat = async (path) => {
				if (path === "/missing") throw new Error(`${"🐙".repeat(40)} no such file`);
				return stat(path);
			};
			const readFileBuffer = fs.readFileBuffer.bind(fs);
			const reads: string[] = [];
			fs.readFileBuffer = async (path) => {
				reads.push(path);
				return readFileBuffer(path);
			};
			const bash = new Bash({
				fs,
				python: true,
				executionLimits: { maxWorkerMessageBytes: capacity + BRIDGE_OVERHEAD, maxPythonTimeoutMs: 3000 },
			});
			const missing = await bash.exec("python3 -c 'open(\"/missing\").read()'");
			expect(missing.exitCode).toBe(1);
			expect(missing.stderr).toContain("[Errno 44] No such file or directory");
			expect(missing.stderr).not.toMatch(/timeout/i);
			expect(await bash.exec("python3 -c 'print(37)'")).toMatchObject({ exitCode: 0, stdout: "37\n", stderr: "" });
			const oversized = await bash.exec('python3 -c \'open("/oversized","rb").read()\'');
			expect(oversized.exitCode).toBe(1);
			expect(oversized.stderr).toContain("[Errno 22] File too large");
			expect(oversized.stderr).not.toMatch(/timeout/i);
			expect(reads).not.toContain("/oversized");
			expect(
				await bash.exec('python3 -c \'import sys; print("é🐙"*40); print("λ🪵"*40,file=sys.stderr)\''),
			).toMatchObject({
				exitCode: 0,
				stdout: `${"é🐙".repeat(40)}\n`,
				stderr: `${"λ🪵".repeat(40)}\n`,
			});
			expect(await bash.exec("python3 -c 'print(38)'")).toMatchObject({ exitCode: 0, stdout: "38\n", stderr: "" });
		},
	);

	it("rejects a file limit below the bridge metadata capacity with its minimum configuration", async () => {
		const bash = new Bash({ python: true, executionLimits: { maxStringLength: 23, maxWorkerMessageBytes: 32768 } });
		expect(await bash.exec("python3 -c 'print(37)'")).toMatchObject({
			exitCode: 1,
			stdout: "",
			stderr: "python3: worker bridge requires maxWorkerMessageBytes >= 4152 and maxStringLength >= 24\n",
		});
		expect(await bash.exec("printf healthy")).toMatchObject({ exitCode: 0, stdout: "healthy", stderr: "" });
	});

	it("releases descriptors after repeated oversized opens", { timeout: 60000 }, async () => {
		const fs = new InMemoryFs({ "/oversized.bin": Buffer.alloc(8194), "/fits.bin": "safe" });
		const bash = new Bash({
			fs,
			python: true,
			executionLimits: { maxWorkerMessageBytes: 8193 + BRIDGE_OVERHEAD },
		});
		const code = `import errno
for i in range(4100):
    try:
        open("/oversized.bin", "rb")
    except OSError as error:
        if error.errno != errno.EFBIG:
            raise
print(open("/fits.bin").read())`;
		expect(await bash.exec(`python3 -c '${code}'`)).toMatchObject({ exitCode: 0, stdout: "safe\n", stderr: "" });
	});

	it("reads and hashes 49 MiB within configured budgets", { timeout: 60000 }, async () => {
		const content = Buffer.alloc(49 * MIB, 0x5a);
		const expectedHash = createHash("sha256").update(content).digest("hex");
		const fs = new InMemoryFs({ "/large.bin": content });
		const bash = new Bash({
			fs,
			python: true,
			executionLimits: {
				maxStringLength: 64 * MIB,
				maxWorkerMessageBytes: 64 * MIB,
				maxPythonBridgeBytes: 64 * MIB - BRIDGE_OVERHEAD,
			},
		});
		const result = await bash.exec(
			`python3 -c 'import hashlib; data=open("/large.bin", "rb").read(); print(len(data)); print(hashlib.sha256(data).hexdigest())'`,
		);
		expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: `${content.length}\n${expectedHash}\n` });
		expect(await bash.exec("python3 -c 'print(37)'")).toMatchObject({ exitCode: 0, stdout: "37\n", stderr: "" });
	});

	it.each(["binary", "text"])("preserves an 8 MiB %s file with the default bridge", async (kind) => {
		const content =
			kind === "binary" ? Buffer.alloc(8 * MIB, 0xff) : Buffer.from(`${"é🐙".repeat(Math.floor((8 * MIB) / 6))}ab`);
		expect(content.length).toBe(8 * MIB);
		const hash = createHash("sha256").update(content).digest("hex");
		const bash = new Bash({ fs: new InMemoryFs({ "/input": content }), python: true });
		const result = await bash.exec(
			`python3 -c 'import hashlib; data=open("/input","rb").read(); print(len(data)); print(hashlib.sha256(data).hexdigest())'`,
		);
		expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: `${content.length}\n${hash}\n` });
	});

	it("rejects a default-bridge oversized read before transferring file bytes", async () => {
		const fs = new InMemoryFs({ "/input": Buffer.alloc(8 * MIB + 1) });
		const read = fs.readFileBuffer.bind(fs);
		let reads = 0;
		fs.readFileBuffer = async (path) => {
			reads++;
			return read(path);
		};
		const bash = new Bash({ fs, python: true });
		const result = await bash.exec('python3 -c \'open("/input","rb").read()\'');
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("File too large");
		expect(reads).toBe(0);
	});

	it.each([
		[8193, 8193 + BRIDGE_OVERHEAD, 32768],
		[4096, 32768, 4096],
	])(
		"enforces a %i byte payload ceiling before reading oversized files",
		{ timeout: 60000 },
		async (capacity, messageBytes, fileBytes) => {
			const fs = new InMemoryFs({
				"/fits.bin": Buffer.alloc(capacity, 0x61),
				"/oversized.bin": Buffer.alloc(capacity + 1, 0x62),
			});
			const readFileBuffer = fs.readFileBuffer.bind(fs);
			const reads: string[] = [];
			fs.readFileBuffer = async (path) => {
				reads.push(path);
				return readFileBuffer(path);
			};
			const bash = new Bash({
				fs,
				python: true,
				executionLimits: { maxStringLength: fileBytes, maxWorkerMessageBytes: messageBytes },
			});
			expect(await bash.exec(`python3 -c 'print(len(open("/fits.bin", "rb").read()))'`)).toMatchObject({
				exitCode: 0,
				stdout: `${capacity}\n`,
				stderr: "",
			});
			const result = await bash.exec(`python3 -c 'open("/oversized.bin", "rb").read()'`);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("[Errno 22] File too large");
			expect(reads).not.toContain("/oversized.bin");
			expect(await bash.exec(`python3 -c 'print(len(open("/fits.bin", "rb").read()))'`)).toMatchObject({
				exitCode: 0,
				stdout: `${capacity}\n`,
				stderr: "",
			});
		},
	);
});
