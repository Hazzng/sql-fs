# Autoscaling

This guide is for operators who run sql-fs in containers and want the replica count to follow load. It covers the probe and metrics endpoints, every metric that `GET /metrics` emits, which signals to scale on, measured capacity for one replica, and an example for Azure Container Apps.

Each replica has fixed capacity. By default it runs 2 worker threads and admits 8 requests at a time. A replica never adds workers by itself, so more load needs more replicas. [CONFIGURATION.md](CONFIGURATION.md) lists every setting named here.

## Endpoints

| Endpoint | Auth | Returns | Use it for |
|---|---|---|---|
| `GET /healthz` | None | Always `200 {"status":"ok"}` while the process serves HTTP. | Liveness. It does not check Postgres or Redis. |
| `GET /readyz` | None | `200 {"status":"ok"}` with an `eventLoop` lag summary. If Redis is configured and does not answer `PING` within 2 s, it returns `503 {"status":"degraded"}`. | Readiness and startup. It does not check Postgres. |
| `GET /metrics` | Bearer JWT | Prometheus text format 0.0.4. | Scraping. |

`/readyz` does not report shutdown. A terminating replica refuses new connections, so probes on new connections fail to connect. The platform must stop routing to a terminating replica by itself. Kubernetes and Azure Container Apps both do so.

`/metrics` accepts the same bearer JWT as the REST API: an HS256 token signed with `AUTH_SECRET`, with a `sub` claim and an optional `tenant` claim that names a configured tenant. Without a valid token it returns 401. The metrics have no tenant labels, so a token for any tenant returns the same numbers. Give the scraper a token with a dedicated `sub`, minted through `POST /v1/auth/admin` or signed with `AUTH_SECRET` directly. In Prometheus, put the token in a file and point the scrape job at it:

Scrape every replica. A load-balanced service address reaches one replica per scrape, so fleet sums and per-replica queries would describe a random replica. On Kubernetes, discover the pods:

```yaml
scrape_configs:
  - job_name: sql-fs
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/sql-fs-token
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: sql-fs-api
        action: keep
      - source_labels: [__meta_kubernetes_pod_ip]
        target_label: __address__
        replacement: "$1:8080"
```

Change the `app` label to match your deployment. On a platform that does not expose each replica's address, use its own per-replica metrics collection instead of one scrape target.

The server also serves `GET /openapi.json` and `GET /docs` for the API schema. They are not operational endpoints.

## Metric reference

Every metric belongs to one replica. A gauge is the replica's current value. A counter counts from process start and resets when the process restarts, so read counters through `rate()` or `increase()`. Use `sum()` across replicas for fleet totals and `max()` to find the hot replica.

The names below come from `src/api/worker-owner/metrics.ts` and from a scrape of a server started with the default settings.

### Feature flags

| Metric | Type | Meaning |
|---|---|---|
| `sql_fs_workers_enabled` | gauge | 1 when `SQL_FS_WORKERS_ENABLED` is `true`. When it is 0, `/metrics` emits only this metric and `sql_fs_ingress_enabled`. |
| `sql_fs_ingress_enabled` | gauge | 1 when ingress admission is on. It is on exactly when workers are on. |

### Worker pool

| Metric | Type | Meaning |
|---|---|---|
| `sql_fs_worker_capacity` | gauge | Configured worker count, `SQL_FS_WORKER_COUNT`. |
| `sql_fs_worker_ready` | gauge | Workers that are started and able to take work. |
| `sql_fs_worker_busy` | gauge | Worker slots held by an admitted operation, including operations that wait for a lock or recovery. For work that executes now, use `sql_fs_worker_running_operations`. |
| `sql_fs_worker_resident_sessions` | gauge | Workers that hold a sandbox loaded. A worker keeps the last sandbox it served until another sandbox needs it. |
| `sql_fs_worker_running_operations` | gauge | Admitted operations that run now. |
| `sql_fs_worker_lock_waiting` | gauge | Admitted operations that wait for the sandbox's distributed lock. |
| `sql_fs_worker_recovering_operations` | gauge | Admitted operations that recover a sandbox after a lost worker or lease. |
| `sql_fs_worker_restarts_total` | counter | Workers replaced after a crash or after they passed a memory limit. |
| `sql_fs_worker_unknown_outcomes_total` | counter | Execs that failed with `EEXEC_OUTCOME_UNKNOWN`. The script may have run. |
| `sql_fs_worker_python_active` | gauge | Python executions that hold one of the `MAX_CONCURRENT_PYTHON` slots. |
| `sql_fs_worker_python_queued` | gauge | Python executions that wait for a slot. |
| `sql_fs_worker_javascript_active` | gauge | JavaScript executions that hold one of the `MAX_CONCURRENT_JS` slots. |
| `sql_fs_worker_javascript_queued` | gauge | JavaScript executions that wait for a slot. |

### Worker admission

| Metric | Type | Meaning |
|---|---|---|
| `sql_fs_worker_queued` | gauge | Operations that wait for a worker. It is the sum of the next two gauges. |
| `sql_fs_worker_runnable_queued` | gauge | Queued operations that a free worker could start. |
| `sql_fs_worker_sandbox_waiting` | gauge | Queued operations that wait behind another operation on the same sandbox. |
| `sql_fs_worker_queued_bytes` | gauge | Bytes that queued operations hold, counted against `SQL_FS_WORKER_QUEUE_BYTES`. |
| `sql_fs_worker_offered_total` | counter | Operations that asked for a worker. |
| `sql_fs_worker_admitted_total` | counter | Operations that got a worker, at once or after a wait. |
| `sql_fs_worker_refused_total` | counter | Operations that failed with `EWORKER_BUSY` (503). It counts a full queue and a wait that ran out. |
| `sql_fs_worker_queue_timeouts_total` | counter | The part of `sql_fs_worker_refused_total` whose wait passed `SQL_FS_WORKER_QUEUE_WAIT_MS`. |
| `sql_fs_worker_cancelled_total` | counter | Operations that left the queue because the client disconnected or the server shut down. |
| `sql_fs_worker_completed_total` | counter | Operations that released their worker. |
| `sql_fs_worker_queue_wait_milliseconds` | histogram | Time from the request for a worker to admission. Buckets: 1, 5, 25, 100, 250, 1000, 2500, 5000, 10000 and 30000 ms. |
| `sql_fs_worker_queue_wait_milliseconds_total` | counter | Same value as the histogram's `_sum`. |

The wait histogram counts admitted operations only. An operation admitted at once records 0. A refused operation records nothing, so the histogram never goes above `SQL_FS_WORKER_QUEUE_WAIT_MS` and hides the requests that hurt most. Read it together with the refusal counters.

### Ingress admission

Ingress admission runs before the worker queue. It bounds the requests that one replica holds, including their request bodies.

| Metric | Type | Meaning |
|---|---|---|
| `sql_fs_ingress_request_capacity` | gauge | Configured ordinary active request limit. |
| `sql_fs_ingress_queue_capacity` | gauge | Configured ordinary queued request limit. |
| `sql_fs_ingress_raw_byte_capacity` | gauge | Configured global retained raw-body byte limit. |
| `sql_fs_ingress_queue_wait_limit_milliseconds` | gauge | Configured ingress queue deadline. |
| `sql_fs_ingress_active_requests` | gauge | Requests that hold one of the `SQL_FS_MAX_INGRESS_REQUESTS` permits. A permit stays held until the response finishes. |
| `sql_fs_ingress_queued_requests` | gauge | Requests that wait for a permit. |
| `sql_fs_ingress_offered_total` | counter | Requests that seek an ordinary ingress permit after the declared body-size check. |
| `sql_fs_ingress_admitted_total` | counter | Requests that acquire an ordinary ingress permit. |
| `sql_fs_ingress_completed_total` | counter | Ordinary ingress permits released after response and retained work completion. |
| `sql_fs_ingress_cancelled_total` | counter | Requests removed before admission by client cancellation, shutdown or an input failure. |
| `sql_fs_ingress_queue_wait_milliseconds` | histogram | Ordinary ingress delay for admitted requests, with the same buckets as worker admission. |
| `sql_fs_ingress_refused_total` | counter | Requests that failed with `EWORKER_BUSY` (503) at ingress. It counts a full queue, a wait that ran out and a body that did not fit the byte budget. It does not count MCP listeners. |
| `sql_fs_ingress_queue_timeouts_total` | counter | The part of `sql_fs_ingress_refused_total` whose wait passed `SQL_FS_MAX_INGRESS_WAIT_MS`. |
| `sql_fs_ingress_retained_raw_bytes` | gauge | Request-body bytes held by queued and admitted requests, counted against `SQL_FS_MAX_INGRESS_BYTES`. Transport buffers are additional memory. |
| `sql_fs_ingress_payload_too_large_total` | counter | Requests that failed with 413 because the body passed its limit. More replicas do not help. |
| `sql_fs_ingress_aborted_total` | counter | Requests whose client disconnected before the server finished. |
| `sql_fs_ingress_mcp_listeners_active` | gauge | Open `GET /mcp` streams. |
| `sql_fs_ingress_mcp_listeners_queued` | gauge | `GET /mcp` streams that wait for a listener permit. |
| `sql_fs_ingress_mcp_listeners_refused_total` | counter | `GET /mcp` streams that failed with 503. |
| `sql_fs_ingress_mcp_listeners_queue_timeouts_total` | counter | The part of `sql_fs_ingress_mcp_listeners_refused_total` whose wait ran out. |

The ingress wait histogram records admitted requests only. Read it with queue depth, refusals and queue timeouts. Requests refused before admission do not appear in its latency distribution. MCP listeners use their separate gauges and counters.

### Memory

| Metric | Type | Meaning |
|---|---|---|
| `sql_fs_worker_process_rss_bytes` | gauge | Resident memory of the whole server process, workers included. Compare it with the container memory limit. |
| `sql_fs_worker_external_bytes` | gauge | Memory outside the V8 heaps that the workers report, such as buffers. |

sql-fs does not export CPU. Read CPU from the platform, for example `container_cpu_usage_seconds_total` from cAdvisor.

## What to scale on

The signals below are in priority order. The queries use a 2 minute window. Shorten it if your scrape interval allows.

### 1. Refusals and timeouts

A 503 `EWORKER_BUSY` is what clients feel. It means a replica had no room for the request within its wait. Scale out when either gate refuses work for more than a short burst.

```promql
# Refusals per second, both gates, whole fleet
sum(rate(sql_fs_ingress_refused_total[2m])) + sum(rate(sql_fs_worker_refused_total[2m]))

# Share of worker requests refused
sum(rate(sql_fs_worker_refused_total[2m])) / sum(rate(sql_fs_worker_offered_total[2m]))

# MCP listener refusals per second
sum(rate(sql_fs_ingress_mcp_listeners_refused_total[2m]))
```

Leave `sql_fs_ingress_payload_too_large_total` out of these queries. A body above its limit fails on every replica.

### 2. Queue depth and wait

Queues and waits grow before refusals start, so they give early warning. With the default 250 ms worker wait, a p95 worker wait above about 100 ms means requests are close to refusal.

```promql
# Worker wait p95, whole fleet. Keep "le" in the grouping.
histogram_quantile(0.95, sum by (le) (rate(sql_fs_worker_queue_wait_milliseconds_bucket[2m])))

# Worker wait p95 per replica
histogram_quantile(0.95, sum by (le, instance) (rate(sql_fs_worker_queue_wait_milliseconds_bucket[2m])))

# Work that more workers could start, per replica
max(sql_fs_worker_runnable_queued)

# Ingress queue, per replica
max(sql_fs_ingress_queued_requests)
```

The p95 normally stays below `SQL_FS_WORKER_QUEUE_WAIT_MS`, because a request that waits longer is refused and not recorded. An event-loop stall can delay the refusal and let a slightly later admission through. Read the deadline and refusal counters alongside the histogram. The top finite bucket is 30000 ms. Quantiles above that bucket report 30000 ms, so use client latency measurements for longer waits.

Scale on `sql_fs_worker_runnable_queued`, not `sql_fs_worker_queued`. The difference is `sql_fs_worker_sandbox_waiting`, which more replicas do not reduce.

### 3. CPU and memory

CPU and RSS are backstops. They catch load that the admission gates do not see, such as a few very heavy scripts.

```promql
# Highest RSS as a share of a 2 GiB limit
max(sql_fs_worker_process_rss_bytes) / (2 * 1024 * 1024 * 1024)
```

As a starting point, scale out above about 70% CPU or 70% of the memory limit. Memory is a poor scaling trigger on its own. One large exec can push a replica from idle to near its limit in one request, faster than any autoscaler reacts. The [measured capacity](#measured-capacity) section shows the worst case.

## What scaling does not fix

Some waits stay the same with more replicas. Watch these gauges, but do not scale on them:

- `sql_fs_worker_sandbox_waiting` counts operations queued behind another operation on the same sandbox. One sandbox runs one writer at a time on any replica.
- `sql_fs_worker_lock_waiting` counts operations that wait for a sandbox's distributed lock, which another replica holds.
- `sql_fs_worker_recovering_operations` counts recoveries after a lost worker or lease.

One tenant can run at most `SQL_FS_WORKER_ACTIVE_TENANT_MAX` execs at a time on each replica. The default is half the worker count, which is 1 with the default 2 workers. A single heavy tenant therefore needs more replicas, or more workers on each replica, even when the replicas are otherwise idle. Its concurrent execs must stay at or below `replicas * SQL_FS_WORKER_ACTIVE_TENANT_MAX`, and reach that only if the load balancer spreads its requests evenly.

Response bytes have no admission budget. Two large exec outputs on one replica can use most of its memory, and more replicas only help if the load balancer spreads those requests. [#267](https://github.com/Hazzng/sql-fs/issues/267) tracks a per-replica output budget.

## Measured capacity

These numbers come from one-off probes on 2026-10-16 against `main` at `c3fd9e0`. Each probe used one replica with 2 GiB of memory, 2 CPUs and the default settings. The numbers show the shape of the limits. Measure your own workload before you rely on them.

| Load | Result |
|---|---|
| 100 agents, separate sandboxes, 5 s think time (about 20 execs/s) | 0 errors, p99 under 50 ms |
| About 100 execs/s offered by one tenant | Saturates at about 71 execs/s, 23% of requests get 503 |
| About 100 execs/s offered by ten tenants | 97 execs/s, 0 errors |
| Small execs at saturation, 2 sandboxes | About 600 execs/s |
| Small execs at saturation, 100 distinct sandboxes | 65 execs/s with one tenant, 115 execs/s with ten tenants |
| Two concurrent 64 MiB outputs that are mostly newlines | Peak memory about 1.45 GiB |

One tenant saturates early because it can hold only one of the two workers. Many distinct sandboxes are slower than a few, because each worker keeps one sandbox loaded and switching to another sandbox costs about 9 ms.

To estimate the replica count:

1. Divide the peak execs per second by the per-replica rate. Use about 70 when one tenant sends most of the load, and about 100 when many tenants share it. If each exec touches a different sandbox, use the lower distinct-sandbox rates from the table.
2. Add about 50% headroom and round up.
3. Check the per-tenant limit. The busiest tenant's concurrent execs must be at or below `replicas * SQL_FS_WORKER_ACTIVE_TENANT_MAX`.

For example, a peak of 300 execs per second from many tenants needs 300 / 100 = 3 replicas, and 5 with headroom. If one tenant runs 6 execs at a time, 5 replicas with the default limit of 1 is too few. That tenant needs 6 replicas, or 3 or more replicas that each run 4 workers with a limit of 2. Startup rejects 4 workers with the default settings. Also set `SQL_FS_WORKER_MAX_PG_CONNECTIONS=8`, and either lower `SQL_FS_WORKER_HEAP_MB` (for example to 256) or raise `SQL_FS_WORKER_MAX_RSS_BYTES`, then size the replica's memory again.

## Doing it well

- Run at least 2 replicas. A single replica drops all traffic while it restarts or drains.
- Configure Redis before you run more than one replica. `REDIS_URL` carries the sandbox locks. The [README](../README.md#deploy-with-docker) describes the multi-replica setup.
- Scale out fast and scale in slowly. A short burst of refusals should add replicas within a minute. Removing replicas should wait for several minutes of low load, so that the count does not swing.
- Let a replica drain before it stops. A script that is cut off mid-run has an unknown outcome, and the client gets no result.
- Retry an explicit 503 with `retryable: true` after `Retry-After`, with jitter and a deadline. A connection failure can hide a completed operation. Reconcile its state before replaying a mutation. Never retry `EEXEC_OUTCOME_UNKNOWN` automatically.
- Size the caps for each box size and keep them fixed. Do not change worker counts, output caps or ingress limits at runtime to absorb load. Add replicas instead. The memory measurements in [CONFIGURATION.md](CONFIGURATION.md#sizing) hold only for the caps they were taken with.

### Shutdown and draining

On `SIGTERM` or `SIGINT`, the server does the following:

1. It closes ingress admission. Queued `/v1` and `/mcp` requests, and new ones on already-open connections, get 503 `ESHUTTINGDOWN` with `Retry-After: 1`. Admitted requests continue.
2. It ends every MCP session's `GET /mcp` listener stream. In-flight MCP tool calls continue.
3. It stops accepting connections, so new connections fail, and waits for open requests to finish.
4. It closes MCP sessions, then lets running worker operations finish for up to 30 s, then closes Postgres and Redis. It exits with code 0.
5. If shutdown has not finished 60 s after the signal, it logs `shutdown_force_exit` and exits with code 1.

The 30 s drain starts only after open requests finish, so an in-flight request effectively has until the 60 s force exit. Neither limit is configurable. A script can run for up to `SQL_FS_WORKER_EXECUTION_MS`, 120 s by default, so a long script can still be cut off. Set the platform's termination grace period above 60 s so that the platform does not kill the process before the server's own limit. To avoid cut-off scripts, keep `SQL_FS_WORKER_EXECUTION_MS` below about 60 s.

### Wait limits

A request can wait twice before it gets a 503. It first waits for an ingress permit, up to `SQL_FS_MAX_INGRESS_WAIT_MS`. An exec then waits for a worker, up to `SQL_FS_WORKER_QUEUE_WAIT_MS`. Both default to 250 ms, so an exec can queue for up to 0.5 s before it fails.

Queue depth and wait are separate controls. `SQL_FS_MAX_INGRESS_QUEUED_REQUESTS` sets the ordinary request queue for each replica. `SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS` sets one tenant's share. Defaults remain 8 and 4, derived from the corresponding active limits. A zero queue count refuses a request immediately when it cannot acquire an active permit. MCP GET listeners retain their separate quotas.

Queued uploads make input progress within the same global and tenant byte budgets as admitted requests. This lets the server observe a disconnect behind unread network data. Active input follows consumer demand. A full byte budget returns 503, and a body above its limit returns 413. Increasing the count does not increase the byte budget or worker capacity.

Size a queue against the delay you accept and the capacity gap you measure. A first estimate is excess incoming requests per second multiplied by the gap until useful capacity arrives. Apply this to the load arriving at each existing replica, including uneven routing. For example, 50 excess requests per second over 20 seconds needs 1000 queue places. A wait shorter than the gap expires first, and a finite queue cannot cover an arbitrary surge. Scale early, retain headroom, and use bounded client retries for explicit overload refusals.

These runs used the same 2 GiB replica as [Measured capacity](#measured-capacity), with clients that waited 1 s after each 503, as `Retry-After: 1` asks. They ran on 2026-10-17.

| Load | `SQL_FS_MAX_INGRESS_WAIT_MS=250` | `SQL_FS_MAX_INGRESS_WAIT_MS=1000` |
|---|---|---|
| 100 agents start at once, 10 tenants | 83 refusals | 83 refusals |
| One tenant, about 100 execs/s offered, three 30 s runs: refusals | 317, 385, 395 | 403, 479, 414 |
| The same runs: successful execs/s | 74.5, 69.8, 68.5 | 67.8, 63.4, 67.2 |
| The same runs: p99 latency | 123, 151, 174 ms | 246, 283, 173 ms |

These historical runs kept queue counts equal to active counts. A longer wait alone therefore left most arrivals outside the queue. Measure depth and wait together before changing defaults, and add replicas for sustained demand.

## Example: Azure Container Apps

### Measuring an existing app

`scripts/verify/aca-load.mjs` runs a bounded open-loop workload against an existing ACA app. It resolves the app's signing secret through your current Azure CLI identity without writing credentials to evidence. Each run owns its sandboxes, verifies durable markers, and removes its resources. Run this only against an app authorized for load testing.

```bash
node scripts/verify/aca-load.mjs load --app virtualfs-api --group rg-harry-dev \
  --duration 30 --rate 5 --pool 30 --max-inflight 30 --hold-ms 250 --retries 0
```

The default evidence directory is `scripts/verify/.run/aca-*`. `summary.json` separates offered arrivals, generator drops, sent attempts, successful operations, explicit overload refusals, and unknown outcomes. `reconciliation.json` checks durable markers before cleanup. To resume interrupted cleanup, run `node scripts/verify/aca-load.mjs cleanup --manifest <evidence>/manifest.json`.

Keep script work fixed when comparing replica counts. This example includes sleep, so its throughput does not establish CPU-intensive bash capacity. Inspect generator delay and drops before attributing a limit to the service. Application metrics are load-balanced samples from individual replicas. Use per-pod Azure Monitor series to establish CPU and memory pressure across the fleet.

For a cold scale-out test, prepare fixtures while ACA is fixed at one replica. Pass `--start-barrier <fresh-path>` to pause the load tool after setup. It writes `<fresh-path>.prepared.json` with a `runId` and waits without application or ARM sampling. Enable the intended scale range, verify that exactly one replica is ready, then atomically write `{"runId":"<prepared-run-id>","release":true}` to `<fresh-path>`. The tool takes its own pre-offer snapshot before starting arrivals. A stale release, stop signal or timeout fails into fixture cleanup. The default wait is five minutes; `--start-barrier-timeout-ms` accepts one second to fifteen minutes. Keep any run whose pre-offer snapshot already shows multiple replicas out of cold-start comparisons.

### Scale rules

`deploy/azure/aca.yaml` starts with 1 CPU, 2 GiB, two workers, bounded five-second waits and an HTTP target of one concurrent request. It uses an immutable image reference. Set its digest to the image you verified. The example keeps at least two replicas for availability; use a minimum of zero for an idle development app when the wake-up delay is acceptable.

The HTTP rule uses ACA's fleet request signal. It needs no application polling or Prometheus service. One scrape of the load-balanced `/metrics` endpoint describes one replica and cannot establish fleet pressure. Use the new metrics to observe queue capacity, wait, refusals and recovery. If you later add per-replica collection, a separate Prometheus rule can use its aggregate.

ACA evaluates its HTTP signal every fifteen seconds. Changing `pollingInterval` affects custom event sources, not this HTTP loop. Scale-down stabilization is also separate from `cooldownPeriod`: allow for the platform's five-minute stabilization window when checking that a fleet has shrunk. See [ACA scale behavior](https://learn.microsoft.com/en-us/azure/container-apps/scale-app#scale-behavior).

The queue waits apply at both gates, so an execution can wait up to ten seconds before it begins. They absorb a bounded burst; they do not hold an arbitrary surge for the whole time that replicas need to start. Clients should retry only explicit retryable overload responses, respect `Retry-After`, add bounded exponential backoff with jitter, and use a deadline that covers the observed scaling gap. Connection failures and unknown execution outcomes still require reconciliation.

Budget shared connections for old and new replicas during a rollout. With blob caching off, each replica holds a control Redis connection. Twenty old plus twenty new replicas already need forty connections before observation and restart headroom. A thirty-connection test instance cannot support that rollout safely. Keep control Redis on `noeviction`; use a separate data Redis when enabling blob caching. Postgres capacity must cover worker pools and metadata pools for configured tenants, including rollout overlap.

### Startup work

Unchanged replicas check `public.sql_fs_migrations` and skip already applied filesystem DDL. This avoids taking filesystem table locks just because capacity is scaling out. Each tenant database records filenames, SHA-256 checksums and application timestamps under the existing transaction advisory lock. Pending DDL and its history commit together; an applied checksum mismatch stops startup.

The first boot of this version against a legacy database establishes that history by applying the existing idempotent files once. Keep traffic idle for that adoption. Deployments with genuinely new migrations still need to account for their DDL locks. See [startup migration configuration](CONFIGURATION.md).

### Hosted measurements, 2026-10-18

These bounded tests ran on the candidate in `virtualfs-api`, ACA Consumption in Australia East. Each replica had 1 CPU and 2 GiB. Two workers retained the default limit of one active execution per tenant. One tenant used distinct sandboxes with durable marker appends. Sandbox setup warmed the app before each thirty-second offer window. No retries were enabled for these fixed-replica points.

The measured app retained its existing `REDIS_RWLOCK_ENABLED=false` and `REDIS_BLOB_CACHE_ENABLED=false` settings. These measurements do not establish the performance of either feature when enabled. The deployment example leaves the read/write-lock default unchanged; it is a starting configuration, not an exact reproduction of the measured app. Hosted startup and liveness used TCP probes; readiness used `/readyz` every two seconds.

| Replicas | Offered writes/s | Successful completions/s during offer window | Eventual successful writes | Client p99 |
| --- | ---: | ---: | ---: | ---: |
| 2 | 6 | 5.97 | 180/180 | 550 ms |
| 5 | 15 | 14.83 | 450/450 | 733 ms |
| 10 | 30 | 29.67 | 900/900 | 855 ms |
| 20 | 60 | 59.20 | 1800/1800 | 879 ms |

Every point had zero generator drops, refusals, unknown outcomes, duplicate markers or missing successful writes. These are tested rates, not estimates of maximum capacity or production latency guarantees. CPU-heavy scripts and same-sandbox contention need separate capacity measurements.

A separate fifteen-second overload run offered 200 writes/s to twenty replicas. It completed 81.2 successful writes/s during the offer window. Including drain, 1613 writes succeeded and 1387 received explicit busy refusals. All 3000 operations reconciled correctly: each successful marker appeared once, each refused marker was absent, and no unknown outcome occurred. The load generator sent every arrival; maximum send delay was 21.3 ms and peak in-flight requests were 405 of the allowed 500. Queueing raised successful-request p99 to 6.05 seconds.

The dependency-pruning experiment used source `4b0a721` with the same AMD64 base images. It produced 179905757 compressed layer bytes with development dependencies and 106470873 after pruning, a 40.82% reduction. Runtime parity covered Git, JavaScript, TypeScript, Python, SQLite, tar, MCP and cross-replica persistence. The later migration-history candidate retains that pruning. Smaller transfer size is not proof of a faster ACA startup.

The throwaway Redis accepted only thirty concurrent connections and refused `noeviction`. Twenty replicas therefore remain a test configuration. Production use requires suitable control Redis, rollout headroom and workload-specific confirmation. The load driver preserves raw summaries and durable reconciliation in its evidence directory.

### Final cold and sustained confirmation

The final candidate, source `e0bf5f3`, adds migration history to the same admission and worker code used for the fixed-replica points above. It ran as immutable image `ghcr.io/hazzng/sql-fs@sha256:fa390528895c1996b6ad0f3ccbc044b6d005c2d8125e9db51faeec506834f330`.

A cold burst began with exactly one ready replica and allowed ACA to grow to ten. It offered twelve operations/s for three minutes, each including 250 ms of waiting work. All 2160 operations succeeded and reconciled once, with no generator drops or unknown outcomes. The reference client sent 3533 attempts, including 1373 explicit safe busy refusals. It retried those refusals within a 120-second operation deadline. Client p99 including queueing and backoff was 47.49 seconds; the maximum was 59.72 seconds.

The scaler's rescale event appeared 9.79 seconds after demand. The earliest retained durable write on a new replica appeared at 28.36 seconds. Ten replicas were first observed ready at 46.40 seconds; that ARM read spanned 10.40 seconds. These are observations from one episode, not startup percentiles or a demonstrated speedup. Queues alone did not hold every request throughout that gap. The existing SDK write-execution defaults retain their conservative retry policy; callers need an explicit safe-overload retry policy to reproduce this result. Unknown outcomes and transport failures require reconciliation.

The earlier cold candidate produced one nonretryable internal error and a container restart while the database deadlock counter rose by two. Repeated startup DDL was independently reproduced blocking behind live filesystem table locks. The final runner skips that DDL on unchanged boots. During the corrected episode the sampled deadlock counter stayed unchanged, with no observed lock waiters or container restarts. The retained earlier logs do not establish the exact cause of that particular internal error or restart.

A separate five-minute confirmation fixed ten final-image replicas and offered thirty short writes/s with no retries. All 9000 operations succeeded and reconciled once, with zero refusals, unknown outcomes, generator drops or marker errors. Successful completions during the offer window were 29.96/s; client p50 was 318 ms, p95 932 ms and p99 1615 ms. Peak in-flight work was 25 of the allowed 200 and maximum initial send delay was 3.31 ms. All 200 fixtures were deleted. This confirms that workload for five minutes; CPU-heavy commands, large files, shared-sandbox contention and longer soaks need their own capacity evidence.
