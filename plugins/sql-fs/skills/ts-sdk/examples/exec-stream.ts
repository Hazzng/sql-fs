/**
 * Streaming exec — consume stdout/stderr as it's produced.
 *
 * Use `sb.execStream(...)` when:
 *   - the script produces output incrementally and you want it live (build logs)
 *   - you want to short-circuit on a specific output pattern
 *
 * Otherwise prefer `sb.exec(...)` (buffered) — simpler, no SSE framing overhead.
 *
 * Run with:
 *   BASE_URL=... AUTH_SECRET=... npx tsx exec-stream.ts
 */

import type { StreamEvent } from "sql-fs-sdk";
import { Client } from "sql-fs-sdk";

async function main(): Promise<number> {
	const client = new Client({
		baseUrl: process.env.BASE_URL!,
		authSecret: process.env.AUTH_SECRET!,
		sub: "streamer",
	});
	try {
		const sb = await client.sandboxes.create({ name: "stream-demo" });
		try {
			const script = `
				for i in 1 2 3 4 5; do
				  echo "stdout line $i"
				  if [ $i -eq 3 ]; then
				    echo "warning at 3" >&2
				  fi
				  sleep 0.2
				done
			`;

			let exitEvent: StreamEvent | undefined;

			// The generator closes the underlying connection automatically on
			// the exit event OR when you `break` out — so it's safe to short-circuit.
			for await (const ev of sb.execStream(script, { timeoutMs: 15_000 })) {
				if (ev.type === "stdout") process.stdout.write(ev.data ?? "");
				else if (ev.type === "stderr") process.stderr.write(`[stderr] ${ev.data}`);
				else if (ev.type === "exit") exitEvent = ev;
			}

			if (exitEvent) {
				console.log(`\n--- exit code=${exitEvent.exitCode} duration=${exitEvent.durationMs} ms ---`);
			}

			// Pattern: short-circuit the stream the moment a sentinel appears.
			console.log("\n[short-circuit demo] stop streaming after 'STOP' line:");
			for await (const ev of sb.execStream(
				"for i in 1 2 3 4 5; do echo line-$i; done; echo STOP; sleep 5; echo never",
				{ timeoutMs: 10_000 },
			)) {
				if (ev.type === "stdout") {
					process.stdout.write(ev.data ?? "");
					if ((ev.data ?? "").includes("STOP")) break; // generator's finally closes the connection
				}
			}
		} finally {
			await client.sandboxes.delete(sb.id);
		}
	} finally {
		client.close();
	}
	return 0;
}

process.exit(await main());
