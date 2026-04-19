/**
 * CLI: Generate JWT tokens for agents/clients.
 * US-057b
 *
 * Usage:
 *   pnpm token:create -- --sub agent-1 --expires 30d
 *   AUTH_SECRET=mysecret pnpm token:create -- --sub agent-1
 */

import { signToken } from "../lib/jwt.js";

function parseArgs(argv: string[]): { sub: string | undefined; expires: string | undefined } {
	let sub: string | undefined;
	let expires: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--sub" && i + 1 < argv.length) {
			sub = argv[i + 1];
			i++;
		} else if (argv[i] === "--expires" && i + 1 < argv.length) {
			expires = argv[i + 1];
			i++;
		}
	}

	return { sub, expires };
}

async function main(): Promise<void> {
	const secret = process.env.AUTH_SECRET;
	if (!secret) {
		process.stderr.write("Error: AUTH_SECRET environment variable is not set.\n");
		process.exit(1);
	}

	const { sub, expires } = parseArgs(process.argv.slice(2));

	if (!sub) {
		process.stderr.write("Error: --sub <identity> is required.\n");
		process.stderr.write("Usage: pnpm token:create -- --sub <identity> [--expires <duration>]\n");
		process.stderr.write("Duration supports: 30d, 1y, 24h, never\n");
		process.exit(1);
	}

	const token = await signToken({ sub, expiresIn: expires, secret });
	process.stdout.write(`${token}\n`);
}

main().catch((err) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
