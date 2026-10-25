import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import { IngressAdmission, loadIngressOptions } from "../../ingress-admission.js";
import { renderWorkerMetrics } from "../../worker-owner/metrics.js";

describe("ingress metrics", () => {
	it("exports configured capacity and cumulative queue waits beyond one second", async () => {
		vi.useFakeTimers();
		const ingress = new IngressAdmission(
			loadIngressOptions({
				SQL_FS_MAX_INGRESS_REQUESTS: "1",
				SQL_FS_MAX_INGRESS_TENANT_REQUESTS: "1",
				SQL_FS_MAX_INGRESS_QUEUED_REQUESTS: "4",
				SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS: "3",
				SQL_FS_MAX_INGRESS_WAIT_MS: "5000",
			}),
		);
		const app = new Hono<{ Variables: AuthVariables }>();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		app.use("*", (c, next) => {
			c.set("tenant", "one");
			return ingress.middleware(c, next);
		});
		app.get("/hold", async (c) => {
			await held;
			return c.text("done");
		});
		app.get("/queued", (c) => c.text("done"));
		const active = app.request("/hold");
		const queued = app.request("/queued");
		try {
			await vi.advanceTimersByTimeAsync(2000);
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1 });
			release();
			await (await active).text();
			await (await queued).text();
			const metrics = renderWorkerMetrics(undefined, ingress.metrics);
			for (const line of [
				"sql_fs_ingress_request_capacity 1",
				"sql_fs_ingress_queue_capacity 4",
				"sql_fs_ingress_raw_byte_capacity 134217728",
				"sql_fs_ingress_queue_wait_limit_milliseconds 5000",
				"sql_fs_ingress_offered_total 2",
				"sql_fs_ingress_admitted_total 2",
				"sql_fs_ingress_completed_total 2",
				"sql_fs_ingress_cancelled_total 0",
				'sql_fs_ingress_queue_wait_milliseconds_bucket{le="1000"} 1',
				'sql_fs_ingress_queue_wait_milliseconds_bucket{le="2500"} 2',
				'sql_fs_ingress_queue_wait_milliseconds_bucket{le="+Inf"} 2',
				"sql_fs_ingress_queue_wait_milliseconds_sum 2000",
				"sql_fs_ingress_queue_wait_milliseconds_count 2",
			]) {
				expect(metrics.split("\n")).toContain(line);
			}
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0 });
		} finally {
			release();
			ingress.close();
			vi.useRealTimers();
		}
	});
});
