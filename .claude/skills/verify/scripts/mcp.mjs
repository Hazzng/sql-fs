#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { record } from "./record.mjs";

function isToolFailure(part) {
	if (part.type !== "text") return false;
	try {
		return JSON.parse(part.text)?.ok === false;
	} catch {
		return false;
	}
}

const { STACK_BASE, STACK_TOKEN, STACK_TRANSCRIPT, STACK_SECRET, STACK_AS } = process.env;
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
		record(STACK_TRANSCRIPT, STACK_SECRET, { transport: "mcp", as: STACK_AS, tool }, tools.map((t) => t.name));
		for (const t of tools) console.log(`${t.name}\t${Object.keys(t.inputSchema.properties ?? {}).join(",")}`);
	} else {
		const args = JSON.parse(rawArgs);
		const response = await client.callTool({ name: tool, arguments: args });
		const parts = response.content;
		const failed = response.isError === true || parts.some(isToolFailure);
		record(STACK_TRANSCRIPT, STACK_SECRET, { transport: "mcp", as: STACK_AS, tool, args, failed }, parts);
		for (const part of parts) console.log(part.type === "text" ? part.text : JSON.stringify(part));
		console.error(`MCP ${tool}: ${failed ? "error" : "ok"}`);
		const expectError = process.env.EXPECT === "error";
		if (failed !== expectError) process.exitCode = 1;
	}
} finally {
	await client.close();
}
