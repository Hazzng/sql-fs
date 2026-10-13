import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalApiRun } from "./local-api.mjs";
import { OpenApiContract } from "./openapi-contract.mjs";

const spec = {
	openapi: "3.0.3",
	info: { title: "test", version: "1" },
	paths: {
		"/example": {
			post: {
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
						},
					},
				},
				responses: {
					200: {
						description: "result",
						content: {
							"application/json": {
								schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
							},
						},
					},
				},
			},
		},
	},
};

function harness() {
	const directory = mkdtempSync(join(tmpdir(), "sqlfs-contract-evidence-"));
	const settings = {
		VERIFY_ENV_FILE: "none",
		VERIFY_EVIDENCE_DIR: directory,
		AUTH_SECRET: "unit-auth-secret",
		DATABASE_URL: "postgres://unit/not-connected",
	};
	const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
	Object.assign(process.env, settings);
	let run;
	try {
		run = new LocalApiRun("contract-test");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	run.openapiContract = new OpenApiContract(spec);
	return {
		run,
		cleanup() {
			process.removeListener("SIGINT", run.onSignal);
			process.removeListener("SIGTERM", run.onSignal);
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

test("retains failed contract exchanges in redacted requests.jsonl", async () => {
	const { run, cleanup } = harness();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ ok: "eyJhbGci.fake.signature" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	try {
		await assert.rejects(
			run.request({ base: "http://local", index: 0 }, null, "POST", "/v1/example", { json: { value: "valid" } }),
			/response:/,
		);
		const evidence = readFileSync(join(run.evidence, "requests.jsonl"), "utf8");
		const records = evidence
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(records[0].path, "/v1/example");
		assert.equal(records[0].response.json.ok, "[REDACTED JWT]");
		assert.equal(records[1].phase, "openapi-validation-failed");
		assert.equal(evidence.includes("eyJhbGci.fake.signature"), false);
	} finally {
		globalThis.fetch = originalFetch;
		cleanup();
	}
});

test("writes observed request and response schema counts into proof.json", async () => {
	const { run, cleanup } = harness();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	try {
		await run.request({ base: "http://local", index: 0 }, null, "POST", "/v1/example", { json: { value: "valid" } });
		await run.finish();
		const proof = JSON.parse(readFileSync(join(run.evidence, "proof.json"), "utf8"));
		assert.deepEqual(proof.schemaValidation, { exchanges: 1, requestSchemas: 1, responseSchemas: 1 });
	} finally {
		globalThis.fetch = originalFetch;
		cleanup();
	}
});


test("retains evidence when response-schema lookup rejects an unknown operation", async () => {
	const { run, cleanup } = harness();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("not documented", { status: 404 });
	try {
		await assert.rejects(run.request({ base: "http://local", index: 0 }, null, "GET", "/v1/missing"), /no GET operation/);
		const records = readFileSync(join(run.evidence, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records[0].path, "/v1/missing");
		assert.equal(records[0].status, 404);
		assert.equal(records[0].response.text, "not documented");
		assert.equal(records[1].phase, "openapi-validation-failed");
	} finally {
		globalThis.fetch = originalFetch;
		cleanup();
	}
});
