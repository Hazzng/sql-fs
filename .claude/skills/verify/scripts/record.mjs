#!/usr/bin/env node
// Appends one redacted event to a stack transcript. CLI form is used by stack.sh `api`; mcp.mjs imports record().
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SENSITIVE_KEY = /token|secret|password|authorization/i;

function redact(value, secret) {
	if (typeof value === "string") {
		const masked = secret ? value.replaceAll(secret, "[REDACTED]") : value;
		return masked.replace(JWT, "[REDACTED JWT]");
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, secret));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, secret)]),
		);
	}
	return value;
}

export function record(file, secret, event) {
	appendFileSync(file, `${JSON.stringify(redact({ at: new Date().toISOString(), ...event }, secret))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [file, method, path, status, as, bodyFile, ...args] = process.argv.slice(2);
	const bytes = readFileSync(bodyFile);
	const text = bytes.toString("utf8");
	let json;
	try {
		json = JSON.parse(text);
	} catch {}
	record(file, process.env.STACK_SECRET, {
		as,
		method,
		path,
		status: Number(status),
		args,
		bytes: bytes.length,
		...(json !== undefined ? { json } : { text: text.slice(0, 4096) }),
	});
}
