import assert from "node:assert/strict";
import test from "node:test";
import { isJsonMediaType, OpenApiContract } from "./openapi-contract.mjs";

const spec = {
	openapi: "3.0.0",
	components: {
		schemas: {
			Error: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
		},
	},
	paths: {
		"/sandboxes/{id}": {
			post: {
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { type: "object", required: ["script"], properties: { script: { type: "string" } } },
						},
					},
				},
				responses: {
					200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
					204: {},
					400: { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
				},
			},
		},
		"/problems": {
			post: {
				requestBody: {
					required: true,
					content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Error" } } },
				},
				responses: {
					400: { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Error" } } } },
				},
			},
		},
		"/text": {
			post: {
				requestBody: {
					required: true,
					content: { "text/plain": { schema: { type: "string", minLength: 2 } } },
				},
				responses: {
					200: { content: { "text/plain": { schema: { type: "string", minLength: 2 } } } },
				},
			},
		},
		"/events": {
			get: {
				responses: {
					200: { content: { "text/event-stream": { schema: { type: "string", minLength: 100 } } } },
				},
			},
		},
		"/sandboxes/{id}/files/{path}": {
			get: {
				responses: { 200: { content: { "*/*": { schema: { type: "string", format: "binary" } } } } },
			},
			put: {
				requestBody: {
					required: true,
					content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
				},
				responses: { 204: {} },
			},
		},
	},
};

const exchange = {
	method: "POST",
	path: "/v1/sandboxes/123",
	status: 200,
	requestContentType: "application/json; charset=utf-8",
	requestBody: { script: "echo ok" },
	responseContentType: "application/json; charset=utf-8",
	responseBody: { code: "OK" },
};

test("validates JSON requests and responses against templated OpenAPI operations", () => {
	assert.doesNotThrow(() => new OpenApiContract(spec).validateExchange(exchange));
});

test("fails when a request operation or status is missing from the document", () => {
	const contract = new OpenApiContract(spec);
	assert.throws(() => contract.validateExchange({ ...exchange, method: "GET" }), /no GET operation/);
	assert.throws(() => contract.validateExchange({ ...exchange, status: 202 }), /no response for HTTP 202/);
});

test("fails when request or response media types do not match the document", () => {
	const contract = new OpenApiContract(spec);
	assert.throws(
		() => contract.validateExchange({ ...exchange, requestContentType: "text/plain" }),
		/request media type/,
	);
	assert.throws(
		() => contract.validateExchange({ ...exchange, responseContentType: "text/plain" }),
		/does not document/,
	);
});

test("fails when request or response JSON violates its documented schema", () => {
	const contract = new OpenApiContract(spec);
	assert.throws(() => contract.validateExchange({ ...exchange, requestBody: {} }), /request:/);
	assert.throws(() => contract.validateExchange({ ...exchange, responseBody: {} }), /response:/);
});

test("matches greedy file paths containing multiple slashes", () => {
	const contract = new OpenApiContract(spec);
	assert.doesNotThrow(() =>
		contract.validateExchange({
			method: "PUT",
			path: "/v1/sandboxes/123/files/home/user/nested/file.txt",
			status: 204,
			requestContentType: "application/octet-stream",
			requestBody: Buffer.from("file bytes"),
			responseContentType: undefined,
		}),
	);
});

test("requires and accepts byte payloads for documented binary requests", () => {
	const contract = new OpenApiContract(spec);
	assert.doesNotThrow(() =>
		contract.validateExchange({
			method: "PUT",
			path: "/v1/sandboxes/123/files/home/user/file.txt",
			status: 204,
			requestContentType: "application/octet-stream",
			requestBodyPresent: true,
			requestBody: Buffer.from([0, 255]),
		}),
	);
	assert.throws(
		() => contract.validateExchange({ method: "PUT", path: "/v1/sandboxes/123/files/home/user/file.txt", status: 204 }),
		/request body is required/,
	);
});

test("allows negative request schemas to be skipped while validating the error response", () => {
	const contract = new OpenApiContract(spec);
	assert.throws(
		() => contract.validateExchange({ ...exchange, status: 400, requestBody: {}, responseBody: { code: "INVALID" } }),
		/request:/,
	);
	assert.doesNotThrow(() =>
		contract.validateExchange({
			...exchange,
			status: 400,
			requestBody: {},
			responseBody: { code: "INVALID" },
			validateRequestSchema: false,
		}),
	);
	assert.throws(
		() =>
			contract.validateExchange({
				...exchange,
				status: 400,
				requestBody: {},
				responseBody: {},
				validateRequestSchema: false,
			}),
		/response:/,
	);
});

test("rejects unsupported OpenAPI schema dialects and compiles every declared schema", () => {
	assert.throws(() => new OpenApiContract({ ...spec, openapi: "3.1.0" }), /OpenAPI 3.0 document required/);
	assert.throws(
		() =>
			new OpenApiContract({
				...spec,
				components: { schemas: { Invalid: { type: "object", unsupportedKeyword: true } } },
			}),
		/unknown keyword/,
	);
});

test("matches OpenAPI wildcard media ranges for extension-dependent binary files", () => {
	const contract = new OpenApiContract(spec);
	const path = "/v1/sandboxes/123/files/home/user/nested/file.txt";
	assert.equal(contract.responseSchema("GET", path, 200, "text/plain; charset=utf-8").format, "binary");
	assert.doesNotThrow(() =>
		contract.validateExchange({
			method: "GET",
			path,
			status: 200,
			responseContentType: "text/plain",
			responseBody: Buffer.from([0xff]),
		}),
	);
	assert.doesNotThrow(() =>
		contract.validateExchange({
			method: "GET",
			path,
			status: 200,
			responseContentType: "application/json",
			responseBody: Buffer.from("{}"),
		}),
	);
});

test("ignores Content-Type on empty 204 responses but rejects an undocumented body", () => {
	const contract = new OpenApiContract(spec);
	assert.doesNotThrow(() =>
		contract.validateExchange({
			method: "PUT",
			path: "/v1/sandboxes/123/files/home/user/file.txt",
			status: 204,
			requestContentType: "application/octet-stream",
			requestBody: Buffer.from("file"),
			responseContentType: "text/plain; charset=UTF-8",
			responseBodyPresent: false,
		}),
	);
	assert.throws(
		() =>
			contract.validateExchange({
				method: "PUT",
				path: "/v1/sandboxes/123/files/home/user/file.txt",
				status: 204,
				requestContentType: "application/octet-stream",
				requestBody: Buffer.from("file"),
				responseBodyPresent: true,
			}),
		/unexpected response body/,
	);
});

test("validates media types with a +json suffix as JSON schemas", () => {
	const contract = new OpenApiContract(spec);
	const value = {
		method: "POST",
		path: "/v1/problems",
		status: 400,
		requestContentType: "application/problem+json",
		requestBody: { code: "REQUEST" },
		responseContentType: "application/problem+json",
		responseBody: { code: "RESPONSE" },
	};
	assert.equal(isJsonMediaType(value.requestContentType), true);
	assert.doesNotThrow(() => contract.validateExchange(value));
	assert.throws(() => contract.validateExchange({ ...value, responseBody: {} }), /response:/);
});

test("validates UTF-8 text request and response schemas and rejects invalid text content", () => {
	const contract = new OpenApiContract(spec);
	const value = {
		method: "POST",
		path: "/v1/text",
		status: 200,
		requestContentType: "text/plain; charset=utf-8",
		requestBody: Buffer.from("héllo", "utf8"),
		responseContentType: "text/plain; charset=utf-8",
		responseBody: Buffer.from("世界", "utf8"),
	};
	assert.deepEqual(contract.validateExchange(value), {
		exchangeValidated: true,
		requestSchemaValidated: true,
		responseSchemaValidated: true,
	});
	assert.throws(() => contract.validateExchange({ ...value, requestBody: Buffer.from("x") }), /request:/);
	assert.throws(() => contract.validateExchange({ ...value, responseBody: Buffer.from("x") }), /response:/);
	assert.throws(
		() => contract.validateExchange({ ...value, responseBody: Buffer.from([0xff]) }),
		/encoded data/,
	);
});

test("excludes SSE payloads from text decoding and schema validation", () => {
	const contract = new OpenApiContract(spec);
	const result = contract.validateExchange({
		method: "GET",
		path: "/v1/events",
		status: 200,
		responseContentType: "text/event-stream; charset=utf-8",
		responseBody: Buffer.from([0xff]),
	});
	assert.equal(result.responseSchemaValidated, false);
});
