import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { containerResources, startApiContainer, stopApiContainer } from "./container-api.mjs";
import { isJsonMediaType, OpenApiContract } from "./openapi-contract.mjs";

export const repo = fileURLToPath(new URL("../../", import.meta.url));
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function compiledIdentity(directory = join(repo, "dist"), prefix = "", productionOnly = false) {
	const files = readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
		left.name.localeCompare(right.name),
	);
	return files
		.flatMap((file) => {
			const relative = prefix + file.name;
			if (file.isDirectory()) {
				if (productionOnly && file.name === "tests") return [];
				return compiledIdentity(join(directory, file.name), `${relative}/`, productionOnly);
			}
			return /\.(?:js|mjs|cjs)$/.test(file.name)
				? [`${relative}:${sha256(readFileSync(join(directory, file.name)))}`]
				: [];
		})
		.join("\n");
}

function pythonAssetIdentity(runtimeRoot) {
	return ["python.cjs", "python.wasm", "python313.zip"].map((name) => {
		const bytes = readFileSync(join(runtimeRoot, "vendor/cpython-emscripten", name));
		return { name, bytes: bytes.length, sha256: sha256(bytes) };
	});
}

export class LocalApiRun {
	constructor(label) {
		const envFile = process.env.VERIFY_ENV_FILE;
		const defaultEnvFile = join(repo, ".env");
		if (envFile !== "none" && (envFile !== undefined || existsSync(defaultEnvFile))) {
			process.loadEnvFile(envFile ?? defaultEnvFile);
		}
		assert.ok(process.env.AUTH_SECRET, "AUTH_SECRET is required");
		assert.ok(process.env.DATABASE_URL || process.env.TENANT_DATABASES, "A local database binding is required");
		this.runId = `${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
		this.evidence = join(process.env.VERIFY_EVIDENCE_DIR ?? join(repo, "scripts/verify/.run"), this.runId);
		mkdirSync(this.evidence, { recursive: true });
		this.servers = [];
		this.artifacts = [];
		this.owners = [];
		this.checks = [];
		this.schemaValidation = { exchanges: 0, requestSchemas: 0, responseSchemas: 0 };
		this.cleanup = [];
		this.clients = [];
		this.secrets = [
			"AUTH_SECRET",
			"ADMIN_SECRET",
			"MCP_API_KEY",
			"DATABASE_URL",
			"DATABASE_DIRECT_URL",
			"REDIS_URL",
			"REDIS_DATA_URL",
			"TENANT_DATABASES",
		]
			.map((name) => process.env[name])
			.filter(Boolean);
		for (const value of this.secrets.slice()) {
			try {
				const password = decodeURIComponent(new URL(value).password);
				if (password) this.secrets.push(password);
			} catch {}
		}
		this.interrupted = new AbortController();
		this.onSignal = () => this.interrupted.abort(new Error("Verification interrupted"));
		process.once("SIGINT", this.onSignal);
		process.once("SIGTERM", this.onSignal);
	}

	redact(value) {
		if (typeof value === "string") {
			return this.secrets
				.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value)
				.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED JWT]");
		}
		if (Array.isArray(value)) return value.map((item) => this.redact(item));
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					/token|secret|password|authorization/i.test(key) ? "[REDACTED]" : this.redact(item),
				]),
			);
		}
		return value;
	}

	record(event) {
		appendFileSync(
			join(this.evidence, "requests.jsonl"),
			`${JSON.stringify(this.redact({ at: new Date().toISOString(), ...event }))}\n`,
		);
	}

	equal(actual, expected, label) {
		assert.deepEqual(actual, expected, label);
		this.checks.push(label);
	}

	async start(extraEnv = {}) {
		const listener = createServer().listen(0, "127.0.0.1");
		await once(listener, "listening");
		const port = listener.address().port;
		await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
		const container = process.env.VERIFY_CONTAINER_IMAGE
			? startApiContainer(
					repo,
					`sql-fs-${this.runId}-${this.servers.length}`,
					{
						...process.env,
						...extraEnv,
						PORT: String(port),
					},
					this.evidence,
				)
			: undefined;
		const child =
			container?.child ??
			spawn(
				process.execPath,
				[
					...(process.env.VERIFY_CPU_PROFILE === "1" ? ["--cpu-prof", `--cpu-prof-dir=${this.evidence}`] : []),
					join(repo, "dist/api/server.js"),
				],
				{
					cwd: repo,
					env: { ...process.env, ...extraEnv, PORT: String(port) },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		const server = {
			child,
			container: container?.container,
			profileDestination:
				container && process.env.VERIFY_CPU_PROFILE === "1" && process.env.VERIFY_IMAGE_ARTIFACT === "1"
					? this.evidence
					: undefined,
			base: `http://127.0.0.1:${port}`,
			index: this.servers.length,
			log: "",
		};
		this.servers.push(server);
		child.on("error", (error) => this.record({ phase: "launch", error: error.message }));
		for (const [name, stream] of [
			["stdout", child.stdout],
			["stderr", child.stderr],
		]) {
			stream.on("data", (chunk) => {
				const text = this.redact(chunk.toString());
				server.log += text;
				appendFileSync(join(this.evidence, `server-${server.index}-${name}.log`), text);
			});
		}
		const runtimeEntry = fileURLToPath(import.meta.resolve("just-bash"));
		const runtimeDist = dirname(dirname(runtimeEntry));
		const runtimeRoot = dirname(runtimeDist);
		const artifact = {
			serverSha256: sha256(readFileSync(join(repo, "dist/api/server.js"))),
			compiledJavaScriptSha256: sha256(compiledIdentity()),
			productionJavaScriptSha256: sha256(compiledIdentity(join(repo, "dist"), "", true)),
			lockfileSha256: sha256(readFileSync(join(repo, "pnpm-lock.yaml"))),
			justBash: {
				version: JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8")).version,
				esmEntrySha256: sha256(readFileSync(runtimeEntry)),
				javaScriptSha256: sha256(compiledIdentity(runtimeDist)),
				pythonAssets: pythonAssetIdentity(runtimeRoot),
			},
		};
		this.artifacts.push({ server: server.index, ...artifact });
		this.record({
			phase: "launch",
			server: server.index,
			pid: child.pid,
			port,
			...artifact,
			configuration: extraEnv,
			profiled: process.env.VERIFY_CPU_PROFILE === "1",
		});
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			this.interrupted.signal.throwIfAborted();
			assert.ok(
				child.exitCode === null && child.signalCode === null,
				"Owned server exited before readiness; inspect evidence logs",
			);
			let ready = false;
			try {
				const response = await fetch(`${server.base}/readyz`, { signal: AbortSignal.timeout(1000) });
				ready = response.ok && (await response.json()).status === "ok";
			} catch {}
			if (ready) {
				if (server.container) {
					server.resourceProfile = await containerResources(server.container);
					server.resourceProfile.artifactOrigin = process.env.VERIFY_IMAGE_ARTIFACT === "1" ? "built image" : "mounted checkout";
					if (process.env.VERIFY_IMAGE_ARTIFACT === "1") {
						const source = `
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = "/app";
const sha256 = ${sha256.toString()};
${compiledIdentity.toString()}
${pythonAssetIdentity.toString()}
const runtimeEntry = fileURLToPath(import.meta.resolve("just-bash"));
console.log(JSON.stringify({
compiledJavaScriptSha256: sha256(compiledIdentity()),
productionJavaScriptSha256: sha256(compiledIdentity(join(repo, "dist"), "", true)),
justBashJavaScriptSha256: sha256(compiledIdentity(dirname(dirname(runtimeEntry)))),
pythonAssets: pythonAssetIdentity(dirname(dirname(dirname(runtimeEntry))))
}));`;
						const artifact = JSON.parse(execFileSync("docker", ["exec", server.container, "node", "--input-type=module", "-e", source], { encoding: "utf8" }));
						this.equal(artifact.productionJavaScriptSha256, sha256(compiledIdentity(join(repo, "dist"), "", true)), "Built image contains every verified production application module");
						this.equal(artifact.justBashJavaScriptSha256, sha256(compiledIdentity(runtimeDist)), "Built image contains the verified runtime patch");
						this.equal(artifact.pythonAssets, pythonAssetIdentity(runtimeRoot), "Built image contains the verified Python assets");
						server.resourceProfile.artifact = artifact;
					}
					this.record({ phase: "container", ...server.resourceProfile });
				}
				return server;
			}
			await delay(100);
		}
		throw new Error("Owned API did not become ready within 30 seconds");
	}

	async owner(tenant, sub = `${this.runId}-${this.owners.length}`) {
		const { signToken } = await import(join(repo, "dist/api/lib/jwt.js"));
		const token = await signToken({ sub, tenant, expiresIn: "24h", secret: process.env.AUTH_SECRET });
		const owner = { sub, tenant: tenant ?? "default", token, sandboxes: new Set() };
		this.owners.push(owner);
		return owner;
	}

	enableOpenApiValidation(spec) {
		this.openapiContract = new OpenApiContract(spec);
	}

	async request(
		server,
		owner,
		method,
		path,
		{ json, raw, status = 200, timeoutMs = 180000, signal, headers = {}, validateRequestSchema = true } = {},
	) {
		const started = performance.now();
		const requestBody = json !== undefined ? JSON.stringify(json) : raw;
		const response = await fetch(server.base + path, {
			method,
			headers: {
				...(owner && { Authorization: `Bearer ${owner.token}` }),
				...(json !== undefined && { "Content-Type": "application/json" }),
				...(raw !== undefined && { "Content-Type": "application/octet-stream" }),
				...headers,
			},
			...(requestBody !== undefined && { body: requestBody }),
			signal: AbortSignal.any([
				AbortSignal.timeout(timeoutMs),
				...(this.cleaning ? [] : [this.interrupted.signal]),
				...(signal ? [signal] : []),
			]),
		});
		const bytes = Buffer.from(await response.arrayBuffer());
		const responseContentType = response.headers.get("content-type");
		const responseSchema = this.openapiContract?.responseSchema(method, path, response.status, responseContentType);
		const body = isJsonMediaType(responseContentType) && bytes.length && responseSchema?.format !== "binary"
			? JSON.parse(bytes)
			: bytes;
		const result = { status: response.status, ms: performance.now() - started, body };
		const describe = (value) =>
			Buffer.isBuffer(value)
				? { bytes: value.length, sha256: sha256(value), ...(value.length < 4096 && { text: value.toString() }) }
				: value;
		const exchange = {
			server: server.index,
			owner: owner?.sub,
			method,
			path,
			status: response.status,
			ms: result.ms,
			request: describe(json ?? raw ?? null),
			response: describe(body),
		};
		// Keep the exchange evidence even when contract validation rejects it.
		this.record(exchange);
		try {
			const validation = this.openapiContract?.validateExchange({
				method,
				path,
				status: response.status,
				requestContentType: headers["Content-Type"] ?? headers["content-type"] ?? (json !== undefined ? "application/json" : raw !== undefined ? "application/octet-stream" : undefined),
				requestBody: json !== undefined ? json : raw,
				requestBodyPresent: json !== undefined || raw !== undefined,
				validateRequestSchema,
				responseContentType,
				responseBody: body,
				responseBodyPresent: bytes.length > 0,
			});
			if (validation) {
				this.schemaValidation.exchanges += Number(validation.exchangeValidated);
				this.schemaValidation.requestSchemas += Number(validation.requestSchemaValidated);
				this.schemaValidation.responseSchemas += Number(validation.responseSchemaValidated);
			}
		} catch (error) {
			this.record({ phase: "openapi-validation-failed", method, path, status: response.status, error: error.message });
			throw error;
		}
		if (status !== null) this.equal(response.status, status, `${method} ${path}: HTTP ${status}`);
		return result;
	}

	async create(server, owner, options = {}) {
		const result = await this.request(server, owner, "POST", "/v1/sandboxes", {
			json: { name: this.runId, ...options },
			status: 201,
		});
		owner.sandboxes.add(result.body.id);
		return { id: result.body.id, path: `/v1/sandboxes/${result.body.id}` };
	}

	async finish(error, detail = {}, afterCleanup) {
		this.cleaning = true;
		for (const client of this.clients) {
			try {
				await client.close();
			} catch (failure) {
				error ??= failure;
			}
		}
		const available = this.servers.find((server) => server.child.exitCode === null && server.child.signalCode === null);
		for (const owner of this.owners) {
			try {
				assert.ok(available, "No owned live server available for cleanup");
				const { body: list } = await this.request(available, owner, "GET", "/v1/sandboxes");
				for (const sandbox of list.sandboxes) owner.sandboxes.add(sandbox.id);
				for (const id of owner.sandboxes) {
					await this.request(available, owner, "DELETE", `/v1/sandboxes/${id}`, { status: 204 });
					owner.sandboxes.delete(id);
				}
				const { body: remaining } = await this.request(available, owner, "GET", "/v1/sandboxes");
				this.equal(remaining.sandboxes, [], "Cleanup leaves no sandbox for this owner");
				this.cleanup.push({ owner: owner.sub, remainingSandboxIds: [], verified: true });
			} catch (failure) {
				this.cleanup.push({
					owner: owner.sub,
					remainingSandboxIds: [...owner.sandboxes],
					verified: false,
					error: failure.message,
				});
				error ??= failure;
			}
		}
		for (const server of this.servers) {
			const child = server.child;
			if (server.container) {
				try {
					await stopApiContainer(server.container, server.profileDestination);
				} catch (failure) {
					error ??= failure;
				}
			}
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
			try {
				await exited;
			} finally {
				clearTimeout(timer);
			}
		}
		if (afterCleanup) {
			try {
				await afterCleanup();
			} catch (failure) {
				error ??= failure;
			}
		}
		const proof = {
			runId: this.runId,
			status: error ? "failed" : "passed",
			revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
			node: process.version,
			artifacts: this.artifacts,
			containers: this.servers.flatMap((server) =>
				server.resourceProfile ? [{ server: server.index, ...server.resourceProfile }] : [],
			),
			checks: this.checks,
			schemaValidation: this.schemaValidation,
			cleanup: this.cleanup,
			ownedServersStopped: this.servers.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
			...detail,
			...(error && { error: error.stack }),
		};
		writeFileSync(join(this.evidence, "proof.json"), `${JSON.stringify(this.redact(proof), null, 2)}\n`);
		process.removeListener("SIGINT", this.onSignal);
		process.removeListener("SIGTERM", this.onSignal);
		console.log(JSON.stringify({ status: proof.status, checks: this.checks.length, evidence: this.evidence }));
		if (error) process.exitCode = 1;
		return proof;
	}
}
