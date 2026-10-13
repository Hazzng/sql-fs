import assert from "node:assert/strict";
import test from "node:test";
import { LocalApiRun } from "./local-api.mjs";

function harness(validateExchange) {
	const run = Object.create(LocalApiRun.prototype);
	run.openapiContract = { responseSchema: () => undefined, validateExchange };
	run.schemaValidation = { exchanges: 0, requestSchemas: 0, responseSchemas: 0 };
	run.secrets = [];
	run.cleaning = true;
	run.interrupted = new AbortController();
	run.records = [];
	run.record = (event) => run.records.push(run.redact(event));
	run.equal = () => {};
	return run;
}

test("records a failed OpenAPI exchange before rethrowing validation errors", async () => {
	const run = harness(() => {
		throw new Error("response schema mismatch for eyJhbGci.fake.signature");
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("eyJhbGci.fake.signature", {
		status: 200,
		headers: { "Content-Type": "text/plain" },
	});
	try {
		await assert.rejects(
			run.request({ base: "http://local", index: 0 }, null, "GET", "/v1/example", { status: null }),
			/response schema mismatch/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(run.records[0].path, "/v1/example");
	assert.equal(run.records[0].response.text, "[REDACTED JWT]");
	assert.equal(run.records[1].phase, "openapi-validation-failed");
	assert.equal(JSON.stringify(run.records).includes("eyJhbGci.fake.signature"), false);
});

test("includes successful schema validation counts in run proof state", async () => {
	const run = harness(() => ({
		exchangeValidated: true,
		requestSchemaValidated: true,
		responseSchemaValidated: true,
	}));
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
	try {
		await run.request({ base: "http://local", index: 0 }, null, "GET", "/v1/example", { status: 200 });
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(run.schemaValidation, { exchanges: 1, requestSchemas: 1, responseSchemas: 1 });
});
