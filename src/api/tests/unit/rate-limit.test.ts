/**
 * Unit tests for the rate-limit primitive (issue #23).
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRateLimitStore, clientIp, rateLimit } from "../../rate-limit.js";

describe("InMemoryRateLimitStore", () => {
	it("allows up to max in window then denies", () => {
		const store = new InMemoryRateLimitStore();
		const now = 1_000_000;
		for (let i = 1; i <= 5; i++) {
			expect(store.hit("k", 60_000, 5, now).allowed).toBe(true);
		}
		expect(store.hit("k", 60_000, 5, now).allowed).toBe(false);
	});

	it("rolls window over after windowMs", () => {
		const store = new InMemoryRateLimitStore();
		const t0 = 1_000_000;
		for (let i = 0; i < 5; i++) store.hit("k", 60_000, 5, t0);
		expect(store.hit("k", 60_000, 5, t0).allowed).toBe(false);
		// Advance past window
		expect(store.hit("k", 60_000, 5, t0 + 60_001).allowed).toBe(true);
	});

	it("reset clears all entries", () => {
		const store = new InMemoryRateLimitStore();
		const now = 1_000_000;
		for (let i = 0; i < 5; i++) store.hit("k", 60_000, 5, now);
		store.reset();
		expect(store.hit("k", 60_000, 5, now).allowed).toBe(true);
	});

	it("tracks keys independently", () => {
		const store = new InMemoryRateLimitStore();
		const now = 1_000_000;
		for (let i = 0; i < 5; i++) store.hit("a", 60_000, 5, now);
		expect(store.hit("a", 60_000, 5, now).allowed).toBe(false);
		expect(store.hit("b", 60_000, 5, now).allowed).toBe(true);
	});

	it("caps live keys via FIFO eviction under attacker-controlled cardinality", () => {
		// Simulate /bootstrap under spoofed XFF: each request gets a fresh key.
		// Without the cap, the Map would grow to N. With maxEntries=4 it stays
		// bounded and the *oldest* keys get evicted (so a returning attacker
		// gets a fresh bucket — acceptable because we are protecting memory,
		// not state).
		const store = new InMemoryRateLimitStore({ maxEntries: 4 });
		const now = 1_000_000;
		for (let i = 0; i < 50; i++) {
			store.hit(`ip:${i}`, 60_000, 5, now);
		}
		expect(store.size()).toBe(4);
		// The most-recently-inserted keys survive (FIFO eviction = oldest first).
		expect(store.hit("ip:49", 60_000, 5, now).remaining).toBe(3); // existing bucket: count 2
		expect(store.hit("ip:0", 60_000, 5, now).remaining).toBe(4); // evicted long ago, fresh bucket
	});
});

describe("rateLimit middleware", () => {
	let logs: string[];
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logs = [];
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			for (const a of args) {
				if (typeof a === "string") logs.push(a);
			}
		});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	function findEvent(event: string): Record<string, unknown> | undefined {
		return logs
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.find((o): o is Record<string, unknown> => o !== null && o.event === event);
	}

	it("enforces 5/min per IP — 6th request returns 429 with Retry-After", async () => {
		const store = new InMemoryRateLimitStore();
		const now = 1_000_000;
		const app = new Hono();
		app.use(
			"/admin",
			rateLimit({
				windowMs: 60_000,
				max: 5,
				scope: "admin",
				keys: () => ["admin:ip:1.2.3.4"],
				store,
				now: () => now,
			}),
		);
		app.post("/admin", (c) => c.json({ ok: true }));

		for (let i = 1; i <= 5; i++) {
			const res = await app.request("/admin", { method: "POST" });
			expect(res.status).toBe(200);
		}
		const res = await app.request("/admin", { method: "POST" });
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBeTruthy();
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("RATE_LIMITED");
	});

	it("trips on per-sub key even when per-IP key would still allow", async () => {
		const store = new InMemoryRateLimitStore();
		const now = 1_000_000;
		const app = new Hono<{ Variables: { owner: string } }>();
		// Set owner so the limiter can read c.get("owner") via keys()
		app.use("/admin", async (c, next) => {
			c.set("owner", "alice");
			await next();
		});
		// Rotate IP via X-Forwarded-For header per request, but key by sub.
		app.use(
			"/admin",
			rateLimit({
				windowMs: 60_000,
				max: 5,
				scope: "admin",
				keys: (c) => {
					const ip = c.req.header("x-forwarded-for") ?? "unknown";
					const sub = (c.get("owner") as string | undefined) ?? "anon";
					return [`admin:ip:${ip}`, `admin:sub:${sub}`];
				},
				store,
				now: () => now,
			}),
		);
		app.post("/admin", (c) => c.json({ ok: true }));

		for (let i = 1; i <= 5; i++) {
			const res = await app.request("/admin", {
				method: "POST",
				headers: { "X-Forwarded-For": `10.0.0.${i}` },
			});
			expect(res.status).toBe(200);
		}
		const res = await app.request("/admin", {
			method: "POST",
			headers: { "X-Forwarded-For": "10.0.0.99" },
		});
		expect(res.status).toBe(429);
	});

	it("emits auth_rate_limited audit log on 429", async () => {
		const store = new InMemoryRateLimitStore();
		const now = 1_000_000;
		const app = new Hono();
		app.use(
			"/admin",
			rateLimit({
				windowMs: 60_000,
				max: 1,
				scope: "admin",
				keys: () => ["admin:ip:1.1.1.1"],
				store,
				now: () => now,
			}),
		);
		app.post("/admin", (c) => c.json({ ok: true }));

		await app.request("/admin", { method: "POST" });
		const res = await app.request("/admin", { method: "POST" });
		expect(res.status).toBe(429);

		const evt = findEvent("auth_rate_limited");
		expect(evt).toBeDefined();
		expect(evt?.scope).toBe("admin");
		expect(evt?.path).toBe("/admin");
	});

	it("bootstrap limiter does not crash when c.get('owner') is unset", async () => {
		const store = new InMemoryRateLimitStore();
		const now = 1_000_000;
		const app = new Hono();
		app.use(
			"/bootstrap",
			rateLimit({
				windowMs: 60_000,
				max: 5,
				scope: "bootstrap",
				// Only IP key — must not read c.get("owner")
				keys: () => ["bootstrap:ip:9.9.9.9"],
				store,
				now: () => now,
			}),
		);
		app.post("/bootstrap", (c) => c.json({ ok: true }));

		for (let i = 1; i <= 5; i++) {
			const res = await app.request("/bootstrap", { method: "POST" });
			expect(res.status).toBe(200);
		}
		const res = await app.request("/bootstrap", { method: "POST" });
		expect(res.status).toBe(429);
	});

	it("clientIp ignores X-Forwarded-For unless TRUST_PROXY_HEADERS=true", async () => {
		const original = process.env.TRUST_PROXY_HEADERS;
		try {
			Reflect.deleteProperty(process.env, "TRUST_PROXY_HEADERS");
			const seen: string[] = [];
			const app = new Hono();
			app.post("/p", (c) => {
				seen.push(clientIp(c));
				return c.json({ ok: true });
			});
			await app.request("/p", { method: "POST", headers: { "X-Forwarded-For": "1.2.3.4" } });
			expect(seen[0]).toBe("unknown");

			process.env.TRUST_PROXY_HEADERS = "true";
			await app.request("/p", { method: "POST", headers: { "X-Forwarded-For": "1.2.3.4" } });
			expect(seen[1]).toBe("1.2.3.4");
		} finally {
			if (original === undefined) Reflect.deleteProperty(process.env, "TRUST_PROXY_HEADERS");
			else process.env.TRUST_PROXY_HEADERS = original;
		}
	});

	it("clientIp prefers socket.remoteAddress when TRUST_PROXY_HEADERS is unset", async () => {
		const original = process.env.TRUST_PROXY_HEADERS;
		try {
			Reflect.deleteProperty(process.env, "TRUST_PROXY_HEADERS");
			const seen: string[] = [];
			const app = new Hono();
			app.post("/p", (c) => {
				seen.push(clientIp(c));
				return c.json({ ok: true });
			});
			// Inject a fake `incoming` on c.env via Hono's `app.fetch` env arg.
			await app.fetch(
				new Request("http://localhost/p", {
					method: "POST",
					headers: { "X-Forwarded-For": "1.2.3.4" },
				}),
				{ incoming: { socket: { remoteAddress: "10.0.0.1" } } },
			);
			// Socket wins over spoofed XFF in default (untrusted) mode.
			expect(seen[0]).toBe("10.0.0.1");
		} finally {
			if (original === undefined) Reflect.deleteProperty(process.env, "TRUST_PROXY_HEADERS");
			else process.env.TRUST_PROXY_HEADERS = original;
		}
	});

	it("window rolls over via injected clock", async () => {
		const store = new InMemoryRateLimitStore();
		let now = 1_000_000;
		const app = new Hono();
		app.use(
			"/admin",
			rateLimit({
				windowMs: 60_000,
				max: 1,
				scope: "admin",
				keys: () => ["admin:ip:1.1.1.1"],
				store,
				now: () => now,
			}),
		);
		app.post("/admin", (c) => c.json({ ok: true }));

		expect((await app.request("/admin", { method: "POST" })).status).toBe(200);
		expect((await app.request("/admin", { method: "POST" })).status).toBe(429);
		now += 60_001;
		expect((await app.request("/admin", { method: "POST" })).status).toBe(200);
	});
});
