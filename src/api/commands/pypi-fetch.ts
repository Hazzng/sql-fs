/**
 * A pip-scoped HTTP client.
 *
 * just-bash's `createSecureFetch` is not reachable through the package's
 * `exports` map (only `.` and `./browser` are exported, and the root export
 * list carries the `SecureFetch` *type* but not the constructor), so `pip`
 * cannot build its own instance with a larger response cap. Sharing
 * `ctx.fetch` with `curl` is not an option either: raising the cap there would
 * raise it for every sandbox command.
 *
 * This wrapper is deliberately narrower than `createSecureFetch` rather than a
 * reimplementation of it:
 *
 * - GET only. Nothing pip does needs another method.
 * - Two fixed hostnames (`pypi.org`, `files.pythonhosted.org`) over HTTPS with
 *   no embedded credentials. Because the host set is fixed and both names are
 *   public CDNs, no DNS resolution or private-range check is needed — the
 *   SSRF surface `denyPrivateRanges` exists for does not exist here.
 * - Redirects are never followed. The caller (`fetchPypi`) walks each hop and
 *   re-validates the target, which is where the hop budget lives.
 * - The response cap is enforced twice: a `content-length` pre-check before a
 *   byte is read, then a streaming counter that aborts the body mid-flight.
 * - A per-request timeout composed with the caller's `AbortSignal`, so an exec
 *   cancellation tears the request down immediately.
 *
 * Follow-up: export `createSecureFetch` from just-bash so this file can be
 * deleted (deliberately not opened as an upstream PR in this phase).
 */

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["pypi.org", "files.pythonhosted.org"]);

export interface PypiFetchResult {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Record<string, string>;
	readonly body: Uint8Array;
	readonly url: string;
}

export interface PypiFetchRequestOptions {
	readonly method?: string;
	readonly headers?: Headers | Record<string, string>;
	readonly body?: string;
	readonly followRedirects?: boolean;
	/** Per-request timeout; clamped to the client's configured timeout. */
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export type PypiFetch = (url: string, options?: PypiFetchRequestOptions) => Promise<PypiFetchResult>;

export interface PypiFetchConfig {
	readonly maxResponseSize: number;
	readonly timeoutMs: number;
	/** Injected in tests; defaults to the host `fetch`. */
	readonly fetchImpl?: typeof globalThis.fetch;
}

export class PypiFetchError extends Error {
	readonly code = "PYPI_FETCH_ERROR";
	constructor(message: string) {
		super(message);
		this.name = "PypiFetchError";
	}
}

/**
 * Named to match just-bash's error so a single `error.name` check in the
 * installer covers both the shared `ctx.fetch` and this client.
 */
export class ResponseTooLargeError extends Error {
	readonly code = "PYPI_RESPONSE_TOO_LARGE";
	constructor(readonly maxSize: number) {
		super(`response exceeds the maximum allowed size of ${maxSize} bytes`);
		this.name = "ResponseTooLargeError";
	}
}

function assertAllowedUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new PypiFetchError("pip fetch received an invalid URL");
	}
	if (parsed.protocol !== "https:") throw new PypiFetchError("pip fetch permits https URLs only");
	if (parsed.username || parsed.password) throw new PypiFetchError("pip fetch refuses URLs carrying credentials");
	if (!ALLOWED_HOSTS.has(parsed.hostname)) {
		throw new PypiFetchError(`pip fetch refuses the host '${parsed.hostname.slice(0, 80)}'`);
	}
	return parsed;
}

function collectHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}

async function readCapped(response: Response, maxResponseSize: number): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > maxResponseSize) throw new ResponseTooLargeError(maxResponseSize);
	}
	const body = response.body;
	if (body === null) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > maxResponseSize) throw new ResponseTooLargeError(maxResponseSize);
			chunks.push(value);
		}
	} finally {
		// Releasing the lock after a cap violation lets the caller's abort tear
		// the socket down instead of leaving it draining in the background.
		reader.cancel().catch(() => undefined);
	}
	const assembled = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		assembled.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return assembled;
}

export function createPypiFetch(config: PypiFetchConfig): PypiFetch {
	const impl = config.fetchImpl ?? globalThis.fetch;
	return async (url, options): Promise<PypiFetchResult> => {
		const method = (options?.method ?? "GET").toUpperCase();
		if (method !== "GET") throw new PypiFetchError("pip fetch permits GET requests only");
		const parsed = assertAllowedUrl(url);
		const timeoutMs = Math.max(1, Math.min(config.timeoutMs, options?.timeoutMs ?? config.timeoutMs));
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
		const response = await impl(parsed.toString(), {
			method: "GET",
			headers: options?.headers,
			// Never follow: the caller re-validates every hop against the allow
			// list and owns the redirect budget.
			redirect: "manual",
			signal,
		});
		const body = await readCapped(response, config.maxResponseSize);
		return {
			status: response.status,
			statusText: response.statusText,
			headers: collectHeaders(response.headers),
			body,
			url: response.url || parsed.toString(),
		};
	};
}
