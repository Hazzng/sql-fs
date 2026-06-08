import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { Client, ValidationError } from "../src/index.js";

const baseUrl = process.env.SQLFS_BASE_URL ?? "http://127.0.0.1:8081";
const authSecret = process.env.AUTH_SECRET ?? "sqlfs-e2e-local-secret";
const statePath = process.env.SQLFS_E2E_STATE ?? "/tmp/sqlfs-ts-sdk-e2e.json";
const phase = process.argv[2];

function createClient(): Client {
	return new Client({
		baseUrl,
		authSecret,
		sub: "typescript-sdk-e2e",
		maxRetries: 2,
	});
}

async function setup(): Promise<void> {
	const client = createClient();
	const token = await client.getToken();
	assert.ok(token.length > 20);

	for (const existing of await client.sandboxes.list()) {
		if (existing.name === "typescript-sdk-e2e") {
			await client.sandboxes.delete(existing.id);
		}
	}

	const sandbox = await client.sandboxes.create({
		name: "typescript-sdk-e2e",
		python_runtime: "stdlib",
		javascript: true,
		files: { "/home/user/seed.txt": "seeded" },
	});

	try {
		const listed = await client.sandboxes.list();
		assert.ok(listed.some((item) => item.id === sandbox.id && item.name === "typescript-sdk-e2e"));

		const info = await client.sandboxes.get(sandbox.id);
		assert.equal(info.id, sandbox.id);
		assert.equal(info.name, "typescript-sdk-e2e");

		assert.equal(await sandbox.fs.readText("/home/user/seed.txt"), "seeded");
		await sandbox.fs.mkdir("/home/user/project/src", { recursive: true });
		await sandbox.fs.write("/home/user/project/src/index.txt", "alpha\nbeta\n");
		await sandbox.fs.writeFiles({
			"/home/user/project/a.txt": "A",
			"/home/user/project/b.txt": "B",
		});
		await sandbox.ingestFiles(
			{
				"nested/message.txt": "ingested",
				"binary.bin": new Uint8Array([0, 1, 2, 255]),
			},
			{ basePath: "/home/user/project/imported" },
		);

		const read = await sandbox.fs.read("/home/user/project/src/index.txt");
		assert.equal(read.text(), "alpha\nbeta\n");
		assert.equal(read.stat?.kind, "file");
		assert.equal(read.stat?.size, 11);

		const tree = await sandbox.fs.tree({ prefix: "/home/user/project", depth: 4 });
		assert.ok(tree.some((entry) => entry.path.endsWith("/src/index.txt")));
		assert.ok(tree.some((entry) => entry.path.endsWith("/imported/binary.bin") && entry.size === 4));

		const exec = await sandbox.exec(
			'printf \'%s:%s\' "$SDK_E2E" "$(cat /home/user/project/imported/nested/message.txt)"',
			{ env: { SDK_E2E: "enabled" } },
		);
		assert.equal(exec.stdout, "enabled:ingested");
		assert.equal(exec.ok, true);

		const python = await sandbox.exec('python3 -c "print(sum([2, 3, 5]))"', { timeoutMs: 60_000 });
		assert.equal(python.stdout.trim(), "10");

		const javascript = await sandbox.exec('node -e "console.log(6 * 7)"');
		assert.equal(javascript.stdout.trim(), "42");

		const batch = await sandbox.execBatch(
			[
				{ id: "a", script: "cat /home/user/project/a.txt" },
				{ id: "b", script: "cat /home/user/project/b.txt" },
				{ id: "count", script: "find /home/user/project -type f | wc -l" },
			],
			{ readOnly: true, perScriptTimeoutMs: 10_000 },
		);
		assert.deepEqual(
			batch.map((item) => [item.id, item.ok]),
			[
				["a", true],
				["b", true],
				["count", true],
			],
		);
		assert.equal(batch[0]?.stdout, "A");
		assert.equal(batch[1]?.stdout, "B");

		const streamEvents = [];
		for await (const event of sandbox.execStream("echo stream-out; echo stream-err >&2; exit 0")) {
			streamEvents.push(event);
		}
		assert.ok(streamEvents.some((event) => event.type === "stdout" && event.data?.includes("stream-out")));
		assert.ok(streamEvents.some((event) => event.type === "stderr" && event.data?.includes("stream-err")));
		assert.equal(streamEvents.at(-1)?.type, "exit");
		assert.equal(streamEvents.at(-1)?.exitCode, 0);

		await assert.rejects(
			sandbox.exec("echo forbidden > /home/user/project/forbidden.txt", { readOnly: true }),
			(error: unknown) => error instanceof ValidationError && error.code === "EREADONLY_VIOLATION",
		);

		await sandbox.fs.delete("/home/user/project/b.txt");
		await assert.rejects(sandbox.fs.read("/home/user/project/b.txt"));

		await writeFile(statePath, JSON.stringify({ sandboxId: sandbox.id }), "utf8");
		console.log(JSON.stringify({ phase: "setup", sandboxId: sandbox.id, status: "ok" }));
	} finally {
		client.close();
	}
}

async function verifyAndCleanup(): Promise<void> {
	const state = JSON.parse(await readFile(statePath, "utf8")) as { sandboxId: string };
	const client = createClient();
	const sandbox = client.sandboxes.attach(state.sandboxId);

	try {
		const info = await client.sandboxes.get(state.sandboxId);
		assert.equal(info.name, "typescript-sdk-e2e");
		assert.equal(await sandbox.fs.readText("/home/user/project/imported/nested/message.txt"), "ingested");

		const persisted = await sandbox.exec(
			'printf \'%s:%s\' "$(cat /home/user/project/a.txt)" "$(wc -c < /home/user/project/imported/binary.bin)"',
			{ readOnly: true },
		);
		assert.equal(persisted.stdout, "A:4");

		await sandbox.fs.delete("/home/user/project/imported", { recursive: true });
		await sandbox.delete();
		const listed = await client.sandboxes.list();
		assert.ok(!listed.some((item) => item.id === state.sandboxId));
		console.log(JSON.stringify({ phase: "verify-cleanup", sandboxId: state.sandboxId, status: "ok" }));
	} finally {
		client.close();
	}
}

if (phase === "setup") {
	await setup();
} else if (phase === "verify-cleanup") {
	await verifyAndCleanup();
} else {
	throw new Error("Usage: tsx examples/e2e-local.ts setup|verify-cleanup");
}
