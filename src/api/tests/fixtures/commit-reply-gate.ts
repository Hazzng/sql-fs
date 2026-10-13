import { once } from "node:events";
import { type Socket, createConnection, createServer } from "node:net";

export async function commitReplyGate(connectionString: string, committed: () => Promise<boolean>) {
	const upstream = new URL(connectionString);
	const sockets = new Set<Socket>();
	const buffered: Array<() => void> = [];
	let armed = false;
	let resolveHeld!: () => void;
	let rejectHeld!: (error: unknown) => void;
	const held = new Promise<void>((resolve, reject) => {
		resolveHeld = resolve;
		rejectHeld = reject;
	});
	const server = createServer((client) => {
		const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port || 5432) });
		sockets.add(client);
		sockets.add(backend);
		let pending = Buffer.alloc(0);
		let processing = false;
		let holding = false;
		let heldFrame = Buffer.alloc(0);
		client.on("data", (bytes) => backend.write(bytes));
		client.on("close", () => {
			sockets.delete(client);
			backend.destroy();
		});
		backend.on("close", () => {
			sockets.delete(backend);
			client.destroy();
		});
		client.on("error", () => backend.destroy());
		backend.on("error", () => client.destroy());
		buffered.push(() => {
			if (!holding) return;
			holding = false;
			client.write(Buffer.concat([heldFrame, pending]));
			heldFrame = Buffer.alloc(0);
			pending = Buffer.alloc(0);
		});
		const drain = async () => {
			if (processing || holding) return;
			processing = true;
			try {
				while (!holding && pending.length >= 5) {
					const length = pending.readInt32BE(1) + 1;
					if (length < 5 || length > 16 * 1024 * 1024) throw new Error("Unexpected PostgreSQL protocol frame");
					if (pending.length < length) return;
					const frame = pending.subarray(0, length);
					pending = pending.subarray(length);
					if (armed && frame[0] === 67 && frame.subarray(5).toString() === "COMMIT\0" && (await committed())) {
						armed = false;
						holding = true;
						heldFrame = frame;
						resolveHeld();
						return;
					}
					client.write(frame);
				}
			} catch (error) {
				rejectHeld(error);
				client.destroy();
				backend.destroy();
			} finally {
				processing = false;
			}
		};
		backend.on("data", (bytes) => {
			pending = Buffer.concat([pending, bytes]);
			void drain();
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a local PostgreSQL proxy address");
	const forwarded = new URL(connectionString);
	forwarded.hostname = "127.0.0.1";
	forwarded.port = String(address.port);
	return {
		connectionString: forwarded.toString(),
		held,
		arm: () => {
			armed = true;
		},
		release: () => {
			for (const flush of buffered) flush();
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
