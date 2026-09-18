/**
 * Harness client and drivers.
 *
 * Deliberately dependency-free (fetch + node builtins) so a scenario cannot fail for reasons
 * unrelated to the server under test.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runDir = process.env.LT_RUN ?? join(here, "..", ".run");

export const CONFIG = {
	replicaA: `http://127.0.0.1:${process.env.LT_REPLICA_A ?? 8101}`,
	replicaB: `http://127.0.0.1:${process.env.LT_REPLICA_B ?? 8102}`,
	replicaFault: `http://127.0.0.1:${process.env.LT_REPLICA_FAULT ?? 8103}`,
	owner: process.env.LT_OWNER ?? "loadtest-owner",
};

export function token() {
	return readFileSync(join(runDir, "token"), "utf8").trim();
}

/** One API surface, pinned to a replica. Never throws on a non-2xx — the status is the datum. */
export class Client {
	constructor(baseUrl, bearer = token()) {
		this.baseUrl = baseUrl;
		this.bearer = bearer;
	}

	async #req(method, path, { body, json, timeoutMs = 120_000 } = {}) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const started = performance.now();
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.bearer}`,
					...(json === undefined ? {} : { "content-type": "application/json" }),
				},
				body: json === undefined ? body : JSON.stringify(json),
				signal: controller.signal,
			});
			const text = await res.text();
			let parsed;
			try {
				parsed = text === "" ? undefined : JSON.parse(text);
			} catch {
				parsed = undefined;
			}
			return { status: res.status, text, json: parsed, ms: performance.now() - started };
		} catch (err) {
			// A client-side abort is a result too: a hang is the finding in several scenarios.
			return { status: 0, error: String(err?.name === "AbortError" ? "timeout" : err), ms: performance.now() - started };
		} finally {
			clearTimeout(timer);
		}
	}

	createSandbox(opts = {}) {
		return this.#req("POST", "/v1/sandboxes", { json: { name: "lt", ...opts } });
	}
	deleteSandbox(id) {
		return this.#req("DELETE", `/v1/sandboxes/${id}`);
	}
	/** Buffered exec. `readOnly: true` takes the shared lock instead of the exclusive one. */
	exec(id, script, opts = {}) {
		return this.#req("POST", `/v1/sandboxes/${id}/exec-sync`, { json: { script, ...opts } });
	}
	readFile(id, path) {
		return this.#req("GET", `/v1/sandboxes/${id}/files/${path.replace(/^\//, "")}`);
	}
	writeFile(id, path, content) {
		return this.#req("PUT", `/v1/sandboxes/${id}/files/${path.replace(/^\//, "")}`, { body: content });
	}
	editFile(id, path, oldString, newString, replaceAll = false) {
		return this.#req("PATCH", `/v1/sandboxes/${id}/files/${path.replace(/^\//, "")}`, {
			json: { oldString, newString, replaceAll },
		});
	}
	writeFiles(id, files) {
		return this.#req("POST", `/v1/sandboxes/${id}/writeFiles`, { json: { files } });
	}
	tree(id) {
		return this.#req("GET", `/v1/sandboxes/${id}/tree`);
	}
}

/** Percentiles from unsorted samples. Returns ms, rounded. */
export function stats(samples) {
	if (samples.length === 0) return { n: 0 };
	const s = [...samples].sort((a, b) => a - b);
	const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
	return {
		n: s.length,
		p50: at(50),
		p95: at(95),
		p99: at(99),
		max: Math.round(s[s.length - 1]),
		mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
	};
}

/**
 * Run `task(i, workerIndex)` with a fixed number of workers for `durationMs` (or `total`
 * iterations). Returns latency samples and a status histogram — never throws, so one failing
 * request does not abort a measurement.
 *
 * `workerIndex` is there so a scenario can give each worker its own paths: workers sharing a path
 * race each other into legitimate 409s, and expected errors in the output hide unexpected ones.
 */
export async function drive({ workers, durationMs, total, task }) {
	const samples = [];
	const codes = new Map();
	const deadline = durationMs === undefined ? undefined : Date.now() + durationMs;
	let issued = 0;
	const worker = async (workerIndex) => {
		for (;;) {
			if (deadline !== undefined && Date.now() >= deadline) return;
			if (total !== undefined && issued >= total) return;
			const i = issued++;
			const r = await task(i, workerIndex);
			samples.push(r?.ms ?? 0);
			const key = String(r?.status ?? "err");
			codes.set(key, (codes.get(key) ?? 0) + 1);
		}
	};
	const started = Date.now();
	await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
	const wallMs = Date.now() - started;
	return {
		wallMs,
		opsPerSec: Math.round((samples.length / wallMs) * 1000),
		latency: stats(samples),
		codes: Object.fromEntries([...codes.entries()].sort()),
	};
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Print a row of an aligned table. */
export function row(cells, widths) {
	console.log(cells.map((c, i) => String(c).padEnd(widths[i])).join("  "));
}
