import { readFile, writeFile } from "node:fs/promises";

const failure = (code) => Object.assign(new Error(code), { code });

export async function waitForStartBarrier(path, runId, { timeoutMs, isStopped = () => false }) {
	const expires = Date.now() + timeoutMs;
	if (isStopped()) throw failure("ESTART_BARRIER_STOPPED");
	await writeFile(`${path}.prepared.json`, JSON.stringify({
		runId, preparedAt: new Date().toISOString(), expiresAt: new Date(expires).toISOString(), releasePath: path,
	}), { flag: "wx" });
	while (!isStopped()) {
		if (Date.now() >= expires) throw failure("ESTART_BARRIER_TIMEOUT");
		let release;
		try { release = JSON.parse(await readFile(path, "utf8")); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		if (isStopped()) break;
		if (Date.now() >= expires) throw failure("ESTART_BARRIER_TIMEOUT");
		if (release !== undefined) {
			if (release?.runId !== runId) throw failure("ESTART_BARRIER_MISMATCH");
			if (release.release !== true) throw failure("ESTART_BARRIER_RELEASE");
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, expires - Date.now()))));
	}
	throw failure("ESTART_BARRIER_STOPPED");
}
