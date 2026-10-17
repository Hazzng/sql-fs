#!/usr/bin/env node
// Calls one MCP tool on the stack started by stack.sh. Invoked via `stack.sh mcp`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { record } from "./record.mjs";

const { STACK_BASE, STACK_TOKEN, STACK_TRANSCRIPT, STACK_SECRET } = process.env;
const [tool, rawArgs = "{}"] = process.argv.slice(2);
const client = new Client({ name: "verify-skill", version: "1.0.0" });
await client.connect(
	new StreamableHTTPClientTransport(new URL(`${STACK_BASE}/mcp`), {
		requestInit: { headers: { Authorization: `Bearer ${STACK_TOKEN}` } },
	}),
);
try {
	if (tool === "list") {
		const { tools } = await client.listTools();
		for (const t of tools) console.log(`${t.name}\t${Object.keys(t.inputSchema?.properties ?? {}).join(",")}`);
	} else {
		const args = JSON.parse(rawArgs);
		const response = await client.callTool({ name: tool, arguments: args });
		record(STACK_TRANSCRIPT, STACK_SECRET, { transport: "mcp", tool, args, response });
		let failed = response.isError === true;
		for (const part of response.content ?? []) {
			console.log(part.type === "text" ? part.text : JSON.stringify(part));
			// File and sandbox tools report failures as isError:false with {"ok":false} (src/api/mcp/tool-errors.ts).
			try {
				if (part.type === "text" && JSON.parse(part.text)?.ok === false) failed = true;
			} catch {}
		}
		console.error(`MCP ${tool}: ${failed ? "error" : "ok"}`);
		const expectError = process.env.EXPECT === "error";
		if (failed !== expectError) process.exitCode = 1;
	}
} finally {
	await client.close();
}
