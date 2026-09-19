/** Shared fakes for the `RedisBlobCache` backpressure suites. */
import type { Redis } from "ioredis";

/** Redis whose `set` never settles until released, so writes stay in flight. */
export class StallingRedis {
	readonly started: string[] = [];
	readonly getKeys: string[] = [];
	readonly unlinked: string[] = [];
	#release: Array<() => void> = [];
	failGet = false;

	async set(key: string): Promise<"OK"> {
		this.started.push(key);
		await new Promise<void>((resolve) => this.#release.push(resolve));
		return "OK";
	}

	async getBuffer(key: string): Promise<Buffer | null> {
		this.getKeys.push(key);
		if (this.failGet) throw new Error("redis get failed");
		return null;
	}

	async mgetBuffer(...keys: string[]): Promise<Array<Buffer | null>> {
		this.getKeys.push(...keys);
		if (this.failGet) throw new Error("redis mget failed");
		return keys.map(() => null);
	}

	async unlink(...keys: string[]): Promise<number> {
		this.unlinked.push(...keys);
		return keys.length;
	}

	releaseAll(): void {
		for (const r of this.#release) r();
		this.#release = [];
	}

	get client(): Redis {
		return this as unknown as Redis;
	}
}

export function sha(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}
