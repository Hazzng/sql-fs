import type { Redis } from "ioredis";
import type { IFileSystem } from "just-bash";
import { vi } from "vitest";

interface Entry {
	value: string;
	expiresAt: number;
}

export class FakeRedis {
	strings = new Map<string, Entry>(); // lock writer keys
	zsets = new Map<string, Map<string, number>>();

	private gc(): void {
		const now = Date.now();
		for (const [k, e] of this.strings) if (e.expiresAt <= now) this.strings.delete(k);
	}

	private reapZset(key: string, nowMs: number): void {
		const z = this.zsets.get(key);
		if (!z) return;
		for (const [m, score] of z) if (score <= nowMs) z.delete(m);
	}

	private getZset(key: string): Map<string, number> {
		let z = this.zsets.get(key);
		if (!z) {
			z = new Map();
			this.zsets.set(key, z);
		}
		return z;
	}

	async incr(): Promise<number> {
		throw new Error("Unexpected version publication");
	}

	async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
		this.gc();
		const keys = args.slice(0, numKeys);
		const argv = args.slice(numKeys);
		if (script.includes("ZREMRANGEBYSCORE") && script.includes("EXISTS")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr, expireAtStr] = argv as [string, string, string];
			this.reapZset(readersKey, Number(nowStr));
			if (this.strings.has(writerKey)) return 0;
			this.getZset(readersKey).set(token, Number(expireAtStr));
			return 1;
		}
		if (script.includes("ZREM") && !script.includes("ZREMRANGEBYSCORE")) {
			const [readersKey] = keys as [string];
			const [token] = argv as [string];
			const z = this.zsets.get(readersKey);
			if (z?.has(token)) {
				z.delete(token);
				return 1;
			}
			return 0;
		}
		if (script.includes("ZSCORE")) {
			const [readersKey] = keys as [string];
			const [token, expireAtStr] = argv as [string, string];
			const z = this.zsets.get(readersKey);
			if (z?.has(token)) {
				z.set(token, Number(expireAtStr));
				return 1;
			}
			return 0;
		}
		if (script.includes("SET") && script.includes("NX")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			if (this.strings.has(writerKey)) return null;
			this.strings.set(writerKey, { value: token, expiresAt: Date.now() + Number(leaseMsStr) });
			return "OK";
		}
		if (script.includes("ZCARD")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value !== token) return -1;
			this.reapZset(readersKey, Number(nowStr));
			return this.zsets.get(readersKey)?.size ?? 0;
		}
		if (script.includes("PEXPIRE")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value === token) {
				entry.expiresAt = Date.now() + Number(leaseMsStr);
				return 1;
			}
			return 0;
		}
		if (script.includes("DEL")) {
			const [writerKey] = keys as [string];
			const [token] = argv as [string];
			const entry = this.strings.get(writerKey);
			if (entry?.value === token) {
				this.strings.delete(writerKey);
				return 1;
			}
			return 0;
		}
		throw new Error(`FakeRedis: unrecognised eval script: ${script.slice(0, 60)}`);
	}
}

export function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

export class StubCoherentFs {
	dirty = false;
	reloadCount = 0;
	clearDirtyCount = 0;
	isPoisoned = false;

	getAllPaths(): string[] {
		return [];
	}
	async ensureFresh(): Promise<void> {}
	async reload(): Promise<void> {
		this.reloadCount++;
		this.dirty = false;
	}
	wasDirty(): boolean {
		return this.dirty;
	}
	clearDirty(): void {
		this.clearDirtyCount++;
		this.dirty = false;
	}
	poisoned(): boolean {
		return this.isPoisoned;
	}
}

export function makeFsFactory(instance: StubCoherentFs): (_t: string, _s: string) => Promise<IFileSystem> {
	return vi.fn(async () => instance as unknown as IFileSystem);
}
