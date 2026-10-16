#!/usr/bin/env node
import { LocalApiRun } from "./local-api.mjs";

const run = new LocalApiRun("output-cap");
const capBytes = 1024 * 1024;
const results = {};
let failure;
try {
	for (const mode of ["true", "false"]) {
		const server = await run.start({ SQL_FS_WORKERS_ENABLED: mode, SQL_FS_WORKER_OUTPUT_BYTES: String(capBytes) });
		const owner = await run.owner();
		const sandbox = await run.create(server, owner);
		const exec = async (chunkBytes, chunks) =>
			(
				await run.request(server, owner, "POST", `${sandbox.path}/exec-sync`, {
					json: { script: `printf "%0${chunkBytes}d" 0\n`.repeat(chunks) },
				})
			).body;
		const within = await exec(capBytes / 2 - 512, 2);
		run.equal(
			[within.exitCode, within.stdout],
			[0, "0".repeat(capBytes - 1024)],
			`workers=${mode}: output under SQL_FS_WORKER_OUTPUT_BYTES returns in full`,
		);
		const over = await exec(capBytes / 2 + 512, 2);
		run.equal(
			[over.exitCode, over.stderr.includes(`total output size exceeded (>${capBytes} bytes)`)],
			[126, true],
			`workers=${mode}: output over SQL_FS_WORKER_OUTPUT_BYTES fails with the output limit error`,
		);
		results[mode] = { exitCode: over.exitCode, stdoutBytes: over.stdout.length, stderr: over.stderr };
		run.record({ case: "over-cap", workers: mode, ...results[mode] });
	}
	run.equal(results.true, results.false, "Over-cap exec fails the same way with and without workers");

	const inline = await run.start({
		SQL_FS_WORKERS_ENABLED: "false",
		SQL_FS_WORKER_OUTPUT_BYTES: String(64 * 1024 * 1024),
	});
	const owner = await run.owner();
	const sandbox = await run.create(inline, owner);
	const twentyMiB = 20 * 1024 * 1024;
	const large = (
		await run.request(inline, owner, "POST", `${sandbox.path}/exec-sync`, {
			json: { script: `printf "%0${twentyMiB}d" 0` },
		})
	).body;
	run.equal(
		[large.exitCode, large.stdout.length, large.stdout === "0".repeat(twentyMiB)],
		[0, twentyMiB, true],
		"workers=false: 20 MiB of output returns in full under the 64 MiB default cap",
	);
} catch (error) {
	failure = error;
} finally {
	await run.finish(failure, { capBytes, results });
}
