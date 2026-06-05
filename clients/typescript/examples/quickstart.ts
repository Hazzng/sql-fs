import { Client } from "../src/index.js";

const client = new Client({
	baseUrl: process.env.SQLFS_BASE_URL ?? "http://localhost:3000",
	authSecret: process.env.AUTH_SECRET,
	token: process.env.SQLFS_TOKEN,
	sub: process.env.SQLFS_SUB ?? "typescript-quickstart",
});

const sandbox = await client.sandboxes.create({ name: "typescript-quickstart", python: true });
try {
	const result = await sandbox.exec("echo hello from sql-fs && pwd");
	console.log(result.stdout);

	await sandbox.fs.write("/home/user/hello.txt", "hello\n");
	console.log(await sandbox.fs.readText("/home/user/hello.txt"));
} finally {
	await sandbox.delete();
	client.close();
}
