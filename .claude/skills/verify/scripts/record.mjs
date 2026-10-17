#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SENSITIVE_KEY = /token|secret|password|authorization/i;
const HEADER = /^([A-Za-z0-9-]+):/;
const BODY_LIMIT = 4096;

function parseJson(text) {
	if (!/^\s*[[{]/.test(text)) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function redactString(value, secret) {
	const parsed = parseJson(value);
	if (parsed !== undefined) return JSON.stringify(redact(parsed, secret));
	const header = HEADER.exec(value);
	if (header && SENSITIVE_KEY.test(header[1])) return `${header[1]}: [REDACTED]`;
	return value.replaceAll(secret, "[REDACTED]").replace(JWT, "[REDACTED JWT]");
}

function redact(value, secret) {
	if (typeof value === "string") return redactString(value, secret);
	if (Array.isArray(value)) return value.map((item) => redact(item, secret));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, secret)]),
		);
	}
	return value;
}

function serialize(value) {
	return typeof value === "string" ? value : JSON.stringify(value);
}

export function record(file, secret, event, body, bytes = Buffer.byteLength(serialize(body))) {
	const redacted = redact(body, secret);
	const text = serialize(redacted);
	const captured =
		Buffer.byteLength(text) <= BODY_LIMIT
			? { body: redacted }
			: { truncated: true, body: Buffer.from(text).subarray(0, BODY_LIMIT).toString("utf8") };
	const entry = { at: new Date().toISOString(), ...redact(event, secret), bytes, ...captured };
	appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [file, method, path, status, as, bodyFile, ...args] = process.argv.slice(2);
	const raw = readFileSync(bodyFile);
	const text = raw.toString("utf8");
	const event = { as, method, path, status: Number(status), args };
	record(file, process.env.STACK_SECRET, event, parseJson(text) ?? text, raw.length);
}
