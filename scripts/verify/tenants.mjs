#!/usr/bin/env node
import assert from "node:assert/strict";
import { join } from "node:path";
import postgres from "postgres";
import { LocalApiRun, repo } from "./local-api.mjs";

const run = new LocalApiRun("tenants");
assert.ok(process.env.DATABASE_URL, "Local multi-tenant verification requires DATABASE_URL with CREATEDB permission");
const admin = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const names = ["a", "b"].map((suffix) => `sqlfs_verify_${run.runId.replace(/[^a-z0-9]/g, "")}_${suffix}`);
const createdDatabases = [];
const bindings = { default: process.env.DATABASE_URL };
let failure;
try {
	for (let index = 0; index < names.length; index++) {
		const name = names[index];
		await admin.unsafe(`CREATE DATABASE "${name}"`);
		createdDatabases.push(name);
		const connection = new URL(process.env.DATABASE_URL);
		connection.pathname = `/${name}`;
		bindings[`verify-${index}`] = connection.href;
		run.secrets.push(connection.href);
	}
	const configuration = JSON.stringify(bindings);
	run.secrets.push(configuration);
	const primary = await run.start({ TENANT_DATABASES: configuration });
	const peer = await run.start({ TENANT_DATABASES: configuration });
	const commonOwner = `${run.runId}-same-owner`;
	const owners = await Promise.all([run.owner("verify-0", commonOwner), run.owner("verify-1", commonOwner)]);
	const sandboxes = [];
	for (let index = 0; index < owners.length; index++) {
		const owner = owners[index];
		const sandbox = await run.create(primary, owner, { files: { "/home/user/same-path.txt": `tenant-${index}\n` } });
		sandboxes.push(sandbox);
		run.equal(
			(await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/same-path.txt`)).body.toString(),
			`tenant-${index}\n`,
			`Cold replica tenant-${index} bytes`,
		);
		await run.request(primary, owner, "POST", `${sandbox.path}/exec-sync`, {
			json: { script: `printf 'updated-${index}\\n' > /home/user/same-path.txt` },
		});
		run.equal(
			(await run.request(peer, owner, "GET", `${sandbox.path}/files/home/user/same-path.txt`)).body.toString(),
			`updated-${index}\n`,
			`Warm replica tenant-${index} committed bytes`,
		);
		const { PostgresDialect } = await import(join(repo, "dist/sql-fs/dialects/postgres.js"));
		const { SqlFs } = await import(join(repo, "dist/sql-fs/sql-fs.js"));
		const dialect = new PostgresDialect(bindings[owner.tenant]);
		await dialect.connect();
		try {
			const fresh = new SqlFs({ dialect, sandboxId: sandbox.id, tenantId: owner.tenant });
			await fresh.ready();
			run.equal(
				Buffer.from(await fresh.readFileBuffer("/home/user/same-path.txt")).toString(),
				`updated-${index}\n`,
				`Fresh Postgres reader tenant-${index}`,
			);
		} finally {
			await dialect.disconnect();
		}
	}
	await run.request(peer, owners[0], "GET", sandboxes[1].path, { status: 404 });
	await run.request(peer, owners[1], "GET", sandboxes[0].path, { status: 404 });
	const unknown = await run.owner("unconfigured");
	const denied = await run.request(primary, unknown, "GET", "/v1/sandboxes", { status: 401 });
	run.equal(denied.body.code, "AUTH_UNKNOWN_TENANT", "Unknown tenant authentication code");
	run.owners.pop();
} catch (error) {
	failure = error;
} finally {
	const detail = {
		coverage: ["real-http-multi-tenant", "cross-replica-coherence", "fresh-postgres-persistence"],
		createdDatabases,
		droppedDatabases: [],
	};
	await run.finish(failure, detail, async () => {
		try {
			for (const name of createdDatabases) {
				await admin.unsafe(`DROP DATABASE "${name}"`);
				detail.droppedDatabases.push(name);
			}
			const remaining = await admin`SELECT datname FROM pg_database WHERE datname IN ${admin(names)}`;
			run.equal(remaining.length, 0, "Owned verification databases removed");
		} finally {
			await admin.end({ timeout: 5 });
		}
	});
}
