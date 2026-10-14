import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaRootId = "urn:sql-fs:openapi-contract";

function rewriteRefs(schema) {
	if (Array.isArray(schema)) return schema.map(rewriteRefs);
	if (!schema || typeof schema !== "object") return schema;
	return Object.fromEntries(
		Object.entries(schema).map(([key, value]) => [
			key,
			key === "$ref" && typeof value === "string" && value.startsWith("#/components/schemas/")
				? `${schemaRootId}#/definitions/${value.slice("#/components/schemas/".length)}`
				: rewriteRefs(value),
		]),
	);
}

function mediaType(value) {
	return value?.split(";", 1)[0]?.trim().toLowerCase();
}

export function isJsonMediaType(value) {
	const subtype = mediaType(value)?.split("/")[1];
	return subtype === "json" || subtype?.endsWith("+json") === true;
}

function matchingMedia(content, actualType) {
	if (!actualType) return undefined;
	const entries = Object.entries(content ?? {});
	const actual = mediaType(actualType);
	const [type] = actual.split("/");
	return (
		entries.find(([candidate]) => mediaType(candidate) === actual)?.[1] ??
		entries.find(([candidate]) => mediaType(candidate) === `${type}/*`)?.[1] ??
		entries.find(([candidate]) => mediaType(candidate) === "*/*")?.[1]
	);
}

function decodeText(value, label) {
	if (typeof value === "string") return value;
	let bytes;
	if (ArrayBuffer.isView(value)) {
		bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	} else if (value instanceof ArrayBuffer) {
		bytes = new Uint8Array(value);
	} else {
		assert.fail(`${label}: text payload must be a UTF-8 string`);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		assert.fail(`${label}: body is not valid UTF-8`);
	}
}

function pathPattern(path) {
	const parts = path.split(/(\{[^}]+\})/g);
	const expression = parts
		.map((part) => {
			const parameter = /^\{([^}]+)\}$/.exec(part);
			if (parameter) return parameter[1] === "path" ? ".+" : "[^/]+";
			return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${expression}$`);
}

export class OpenApiContract {
	constructor(spec) {
		assert.match(spec.openapi ?? "", /^3\.0\.\d+$/, "OpenAPI 3.0 document required");
		this.ajv = new Ajv({ allErrors: true });
		addFormats(this.ajv);
		for (const keyword of ["example", "externalDocs", "xml"]) this.ajv.addKeyword({ keyword, valid: true });
		this.ajv.addFormat("binary", true);
		this.ajv.addSchema({
			$id: schemaRootId,
			definitions: rewriteRefs(spec.components?.schemas ?? {}),
		});
		this.validators = new WeakMap();
		const compileDeclaredSchemas = (value) => {
			if (Array.isArray(value)) {
				for (const item of value) compileDeclaredSchemas(item);
			} else if (value && typeof value === "object") {
				for (const [key, child] of Object.entries(value)) {
					if (key === "schema") this.compileSchema(child);
					else compileDeclaredSchemas(child);
				}
			}
		};
		for (const schema of Object.values(spec.components?.schemas ?? {})) this.compileSchema(schema);
		compileDeclaredSchemas(spec.paths ?? {});
		this.operations = Object.entries(spec.paths ?? {}).flatMap(([path, pathItem]) =>
			Object.entries(pathItem)
				.filter(
					([method, operation]) =>
						["get", "post", "put", "patch", "delete", "options", "head"].includes(method) &&
						operation &&
						typeof operation === "object",
				)
				.map(([method, operation]) => ({
					path,
					method: method.toUpperCase(),
					operation,
					pattern: pathPattern(path),
				})),
		);
	}

	match(method, pathname) {
		const path = pathname.startsWith("/v1/") ? pathname.slice(3) : pathname;
		const operation = this.operations.find(
			(candidate) => candidate.method === method.toUpperCase() && candidate.pattern.test(path),
		);
		assert.ok(operation, `OpenAPI has no ${method.toUpperCase()} operation for ${pathname}`);
		return operation;
	}

	responseSchema(method, path, status, contentType) {
		const pathname = new URL(path, "http://localhost").pathname;
		if (!pathname.startsWith("/v1/")) return undefined;
		const { operation } = this.match(method, pathname);
		const response = operation.responses?.[String(status)] ?? operation.responses?.default;
		return matchingMedia(response?.content, contentType)?.schema;
	}

	compileSchema(schema) {
		if (!schema || this.validators.has(schema)) return;
		this.validators.set(schema, this.ajv.compile(rewriteRefs(schema)));
	}

	validateSchema(schema, value, label) {
		if (!schema) return;
		this.compileSchema(schema);
		const validate = this.validators.get(schema);
		assert.equal(validate(value), true, `${label}: ${this.ajv.errorsText(validate.errors, { separator: "; " })}`);
	}

	validateExchange({
		method,
		path,
		status,
		requestContentType,
		requestBody,
		requestBodyPresent = requestBody !== undefined,
		validateRequestSchema = true,
		responseContentType,
		responseBody,
		responseBodyPresent = responseBody !== undefined,
	}) {
		const pathname = new URL(path, "http://localhost").pathname;
		if (!pathname.startsWith("/v1/")) return undefined;
		const validation = { exchangeValidated: true, requestSchemaValidated: false, responseSchemaValidated: false };
		const { operation } = this.match(method, pathname);
		const requestContract = operation.requestBody;
		if (requestContract?.required)
			assert.equal(requestBodyPresent, true, `${method} ${pathname}: request body is required`);
		if (requestBodyPresent) {
			assert.ok(requestContract, `${method} ${pathname}: request body is not documented`);
			const requestType = mediaType(requestContentType);
			const requestMedia = matchingMedia(requestContract.content, requestType);
			assert.ok(
				requestMedia,
				`${method} ${pathname}: request media type ${requestType ?? "(missing)"} is undocumented`,
			);
			if (validateRequestSchema && isJsonMediaType(requestType)) {
				this.validateSchema(requestMedia.schema, requestBody, `${method} ${pathname} request`);
				validation.requestSchemaValidated = Boolean(requestMedia.schema);
			} else if (validateRequestSchema && requestType?.startsWith("text/") && requestMedia.schema?.type === "string") {
				this.validateSchema(
					requestMedia.schema,
					decodeText(requestBody, `${method} ${pathname} request`),
					`${method} ${pathname} request`,
				);
				validation.requestSchemaValidated = true;
			}
			if (requestType === "application/octet-stream" && requestMedia.schema?.format === "binary") {
				assert.ok(
					Buffer.isBuffer(requestBody) ||
						ArrayBuffer.isView(requestBody) ||
						requestBody instanceof ArrayBuffer ||
						typeof requestBody === "string",
					`${method} ${pathname}: binary request body must contain bytes`,
				);
			}
		}

		const response = operation.responses?.[String(status)] ?? operation.responses?.default;
		assert.ok(response, `OpenAPI ${method} ${pathname} has no response for HTTP ${status}`);
		const responseType = mediaType(responseContentType);
		const documentedMedia = response.content ? Object.keys(response.content) : [];
		if (documentedMedia.length === 0) {
			assert.equal(responseBodyPresent, false, `${method} ${pathname} HTTP ${status}: unexpected response body`);
			if (Number(status) !== 204 && Number(status) !== 304) {
				assert.equal(
					responseType,
					undefined,
					`${method} ${pathname} HTTP ${status}: unexpected response media type ${responseType}`,
				);
			}
		} else {
			assert.ok(responseType, `${method} ${pathname} HTTP ${status}: missing response Content-Type`);
			const responseMedia = matchingMedia(response.content, responseType);
			assert.ok(responseMedia, `OpenAPI ${method} ${pathname} HTTP ${status} does not document ${responseType}`);
			if (isJsonMediaType(responseType) && responseMedia.schema?.format !== "binary") {
				assert.notEqual(responseBody, undefined, `${method} ${pathname} HTTP ${status}: JSON response body is missing`);
				this.validateSchema(responseMedia.schema, responseBody, `${method} ${pathname} HTTP ${status} response`);
				validation.responseSchemaValidated = Boolean(responseMedia.schema);
			} else if (
				responseMedia.schema?.format !== "binary" &&
				responseType !== "text/event-stream" &&
				responseType?.startsWith("text/") &&
				responseMedia.schema?.type === "string" &&
				responseBody !== undefined
			) {
				this.validateSchema(
					responseMedia.schema,
					decodeText(responseBody, `${method} ${pathname} HTTP ${status} response`),
					`${method} ${pathname} HTTP ${status} response`,
				);
				validation.responseSchemaValidated = true;
			}
		}
		return validation;
	}
}
