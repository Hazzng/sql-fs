import { Bash, InMemoryFs } from "just-bash";
import { expect, it } from "vitest";

it(
	"serializes real Python reads across fresh Bash command wrappers on one filesystem",
	{ timeout: 20000 },
	async () => {
		const fs = new InMemoryFs({ "/input": "safe" });
		const originalRead = fs.readFileBuffer.bind(fs);
		let reads = 0;
		let releaseRead: () => void = () => {};
		const heldRead = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		fs.readFileBuffer = async (path) => {
			if (path === "/input" && ++reads === 1) await heldRead;
			return await originalRead(path);
		};
		const shell = () =>
			new Bash({ fs, python: true, defenseInDepth: false, executionLimits: { maxWorkerMessageBytes: 8192 } });
		const command = "python3 -c 'print(open(\"/input\").read())'";
		const first = shell().exec(command);
		let second: ReturnType<Bash["exec"]> | undefined;
		let before: number | undefined;
		try {
			await expect.poll(() => reads, { timeout: 5000 }).toBe(1);
			second = shell().exec(command);
			await new Promise((resolve) => setTimeout(resolve, 500));
			before = reads;
		} finally {
			releaseRead();
			await Promise.allSettled(second === undefined ? [first] : [first, second]);
		}
		expect(before).toBe(1);
		expect(await first).toMatchObject({ exitCode: 0, stdout: "safe\n", stderr: "" });
		expect(await second).toMatchObject({ exitCode: 0, stdout: "safe\n", stderr: "" });
		expect(reads).toBe(2);
	},
);
