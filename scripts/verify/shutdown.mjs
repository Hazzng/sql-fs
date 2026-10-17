#!/usr/bin/env node
import { once } from "node:events";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { LocalApiRun, repo } from "./local-api.mjs";

const run = new LocalApiRun("shutdown");
let failure;
try {
	const server = await run.start({ SQL_FS_WORKERS_ENABLED: "true" });
	// No run.owner(): its cleanup needs a live server after this one exits.
	const { signToken } = await import(join(repo, "dist/api/lib/jwt.js"));
	const token = await signToken({ sub: `${run.runId}-mcp`, expiresIn: "1h", secret: process.env.AUTH_SECRET });
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
	};
	const initialize = await fetch(`${server.base}/mcp`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "shutdown-verifier", version: "1" } },
		}),
	});
	await initialize.text();
	const sessionId = initialize.headers.get("mcp-session-id");
	run.equal(typeof sessionId === "string" && sessionId.length > 0, true, "MCP session opened");
	const sessionHeaders = { ...headers, "mcp-session-id": sessionId };
	const initialized = await fetch(`${server.base}/mcp`, {
		method: "POST",
		headers: sessionHeaders,
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});
	await initialized.text();
	const listener = await fetch(`${server.base}/mcp`, {
		method: "GET",
		headers: { ...sessionHeaders, Accept: "text/event-stream" },
	});
	run.equal(listener.status, 200, "MCP listener stream is open before SIGTERM");
	const drained = listener.body
		.pipeTo(new WritableStream())
		.then(() => "ended")
		.catch(() => "aborted");

	const started = performance.now();
	const exited = once(server.child, "close");
	server.child.kill("SIGTERM");
	const [code] = await exited;
	const seconds = (performance.now() - started) / 1000;
	run.record({ case: "sigterm-with-mcp-listener", exitCode: code, seconds, listener: await drained });
	run.equal(code, 0, "SIGTERM with an open MCP listener exits cleanly");
	run.equal(seconds < 10, true, "SIGTERM with an open MCP listener does not wait for the force-exit timer");
	run.equal(server.log.includes('"event":"shutdown_complete"'), true, "Shutdown logs shutdown_complete");
	run.equal(server.log.includes('"event":"shutdown_force_exit"'), false, "Shutdown does not force-exit");
} catch (error) {
	failure = error;
} finally {
	await run.finish(failure);
}
