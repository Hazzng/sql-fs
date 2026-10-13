import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { IngressAdmission } from "../../dist/api/ingress-admission.js";

let assertions = 0;
function equal(actual, expected) {
	assert.equal(actual, expected);
	assertions++;
}

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("hono")), "utf8"));
equal(metadata.name, "hono");
equal(typeof metadata.version, "string");
const stackHonoBodyLimit = process.argv.includes("--stack-hono");
const app = new Hono();
const ingress = new IngressAdmission({
	maxRequests: 8,
	maxTenantRequests: 4,
	maxBytes: 100,
	maxTenantBytes: 75,
	maxBodyBytes: 256,
});
app.use("*", async (c, next) => {
	c.set("tenant", "verify");
	await next();
});
app.use("*", ingress.middleware);
if (stackHonoBodyLimit) app.use("*", bodyLimit({ maxSize: 256 }));
app.onError((error) => {
	if (error.name !== "AbortError") throw error;
	return new Response(null, { status: 499 });
});
let written = "";
app.put("/write", async (c) => {
	written = await c.req.text();
	return c.text("written");
});
const controller = new AbortController();
const body = new ReadableStream({
	start(output) {
		output.enqueue(new TextEncoder().encode("partial"));
	},
});
const pending = app.request(
	new Request("http://localhost/write", {
		method: "PUT",
		body,
		signal: controller.signal,
		duplex: "half",
	}),
);
const deadline = Date.now() + 1000;
while (ingress.metrics.retainedRawBytes === 0 && Date.now() < deadline) {
	await new Promise((resolve) => setImmediate(resolve));
}
equal(ingress.metrics.retainedRawBytes, 7);
controller.abort();
const response = await pending;
equal(response.status, 499);
equal(written, stackHonoBodyLimit ? "partial" : "");
equal(Buffer.byteLength(written), stackHonoBodyLimit ? 7 : 0);
equal(ingress.metrics.activeRequests, 0);
equal(ingress.metrics.retainedRawBytes, 0);
equal(ingress.metrics.aborted, 1);
console.log(
	JSON.stringify({
		passed: true,
		assertions,
		honoVersion: metadata.version,
		stackHonoBodyLimit,
		status: response.status,
		written,
		metrics: ingress.metrics,
	}),
);
