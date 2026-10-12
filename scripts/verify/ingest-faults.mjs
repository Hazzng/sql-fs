import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { isMainThread } from "node:worker_threads";

const prefix = process.env.MCP_INGEST_VERIFY_PREFIX;
if (isMainThread && prefix) {
	const trace = (path, bytes) => {
		if (typeof path === "string" && path.startsWith(prefix)) {
			console.log(JSON.stringify({ event: "ingest-host-read", name: path.slice(prefix.length), bytes, rssBytes: process.memoryUsage().rss }));
		}
	};
	const readFile = fs.promises.readFile;
	fs.promises.readFile = async function (path, ...args) {
		const value = await readFile.call(this, path, ...args);
		trace(path, typeof value === "string" ? Buffer.byteLength(value) : value.byteLength);
		return value;
	};
	const open = fs.promises.open;
	fs.promises.open = async function (path, ...args) {
		const handle = await open.call(this, path, ...args);
		if (typeof path === "string" && path.startsWith(prefix)) {
			const read = handle.read;
			handle.read = async function (...options) {
				const value = await read.call(this, ...options);
				trace(path, value.bytesRead);
				return value;
			};
		}
		return handle;
	};
	syncBuiltinESMExports();
}
