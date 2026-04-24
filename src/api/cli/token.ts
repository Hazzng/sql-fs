/**
 * CLI: Generate JWT tokens for agents/clients.
 * US-057b
 *
 * Usage:
 *   pnpm token:create -- --sub agent-1 --expires 30d
 *   pnpm token:create -- --sub agent-1 --tenant tenant-a --expires 30d
 *   AUTH_SECRET=mysecret pnpm token:create -- --sub agent-1
 *
 * When --tenant is omitted the token carries no tenant claim; the auth layer
 * resolves it to the default tenant for backward compatibility with
 * single-tenant deployments.
 */

import { signToken } from "../lib/jwt.js";

interface CliArgs {
	sub: string | undefined;
	tenant: string | undefined;
	expires: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
	let sub: string | undefined;
	let tenant: string | undefined;
	let expires: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--sub" && i + 1 < argv.length) {
			sub = argv[i + 1];
			i++;
		} else if (argv[i] === "--tenant" && i + 1 < argv.length) {
			tenant = argv[i + 1];
			i++;
		} else if (argv[i] === "--expires" && i + 1 < argv.length) {
			expires = argv[i + 1];
			i++;
		}
	}

	return { sub, tenant, expires };
}

async function main(): Promise<void> {
	const secret = process.env.AUTH_SECRET;
	if (!secret) {
		process.stderr.write("Error: AUTH_SECRET environment variable is not set.\n");
		process.exit(1);
	}

	const { sub, tenant, expires } = parseArgs(process.argv.slice(2));

	if (!sub) {
		process.stderr.write("Error: --sub <identity> is required.\n");
		process.stderr.write(
			"Usage: pnpm token:create -- --sub <identity> [--tenant <tenant-id>] [--expires <duration>]\n",
		);
		process.stderr.write("Duration supports: 30d, 1y, 24h, never\n");
		process.exit(1);
	}

	const token = await signToken({ sub, tenant, expiresIn: expires, secret });
	process.stdout.write(`${token}\n`);
}

main().catch((err) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
