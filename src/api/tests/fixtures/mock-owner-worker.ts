import { EventEmitter } from "node:events";
import type { OwnerMetadata, OwnerReply, OwnerRequest } from "../../worker-owner/protocol.js";

export class MockOwnerWorker extends EventEmitter {
	static readonly instances: MockOwnerWorker[] = [];
	readonly requests: OwnerRequest[] = [];
	metadata: OwnerMetadata | undefined;
	externalBytes = 0;
	postFailure: Error | undefined;
	onPost: ((request: OwnerRequest) => void) | undefined;
	termination: Promise<void> | undefined;
	terminationCalls = 0;

	constructor() {
		super();
		MockOwnerWorker.instances.push(this);
		queueMicrotask(() => this.emit("message", { kind: "ready" }));
	}

	postMessage(request: OwnerRequest): void {
		if (this.postFailure !== undefined) throw this.postFailure;
		this.requests.push(request);
		if (this.onPost !== undefined) {
			this.onPost(request);
			return;
		}
		const { command } = request;
		if (command.kind === "attach") {
			this.metadata = {
				owner: command.identity.owner,
				createdAt: "2026-01-01",
				cwd: command.identity.cwd,
				dirty: false,
				poisoned: false,
				pathCacheBytes: 32,
			};
		}
		if (command.kind === "disconnect" || command.kind === "shutdown") this.metadata = undefined;
		const value =
			command.kind === "exec"
				? { stdout: "ok\n", stderr: "", exitCode: 0 }
				: command.kind === "paths"
					? ["/home/user"]
					: undefined;
		this.reply(request, { ok: true, value });
	}

	reply(
		request: OwnerRequest,
		outcome: { ok: true; value: unknown } | { ok: false; error: Error & { code?: string } },
	): void {
		const reply: OwnerReply = {
			id: request.id,
			generation: request.generation,
			metadata: this.metadata,
			readOnlyViolated: false,
			memory: { heapUsed: 0, external: this.externalBytes, rss: 0 },
			...outcome,
		};
		queueMicrotask(() => this.emit("message", reply));
	}

	async terminate(): Promise<number> {
		this.terminationCalls++;
		await this.termination;
		this.emit("exit", 0);
		return 0;
	}
}

export function latestMockWorker(): MockOwnerWorker {
	const worker = MockOwnerWorker.instances.at(-1);
	if (worker === undefined) throw new Error("No worker was started");
	return worker;
}
