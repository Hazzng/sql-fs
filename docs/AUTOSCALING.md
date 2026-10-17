# Autoscaling

This guide is for operators who run sql-fs in containers and want the replica count to follow load. It covers the probe and metrics endpoints, every metric that `GET /metrics` emits, which signals to scale on, measured capacity for one replica, and an example for Azure Container Apps.

Each replica has fixed capacity. By default it runs 2 worker threads and admits 8 requests at a time. A replica never adds workers by itself, so more load needs more replicas. [CONFIGURATION.md](CONFIGURATION.md) lists every setting named here.

## Endpoints

| Endpoint | Auth | Returns | Use it for |
|---|---|---|---|
| `GET /healthz` | None | Always `200 {"status":"ok"}` while the process serves HTTP. | Liveness. It does not check Postgres or Redis. |
| `GET /readyz` | None | `200 {"status":"ok"}` with an `eventLoop` lag summary. If Redis is configured and does not answer `PING` within 2 s, it returns `503 {"status":"degraded"}`. | Readiness and startup. It does not check Postgres. |
| `GET /metrics` | Bearer JWT | Prometheus text format 0.0.4. | Scraping. |

`/readyz` keeps returning 200 while the server shuts down. The platform must stop routing to a terminating replica by itself. Kubernetes and Azure Container Apps both do so.

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
| `sql_fs_worker_busy` | gauge | Workers that run an operation now. |
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
| `sql_fs_worker_queue_wait_milliseconds` | histogram | Time from the request for a worker to admission. Buckets: 1, 5, 25, 100, 250 and 1000 ms. |
| `sql_fs_worker_queue_wait_milliseconds_total` | counter | Same value as the histogram's `_sum`. |

The wait histogram counts admitted operations only. An operation admitted at once records 0. A refused operation records nothing, so the histogram never goes above `SQL_FS_WORKER_QUEUE_WAIT_MS` and hides the requests that hurt most. Read it together with the refusal counters.

### Ingress admission

Ingress admission runs before the worker queue. It bounds the requests that one replica holds, including their request bodies.

| Metric | Type | Meaning |
|---|---|---|
| `sql_fs_ingress_active_requests` | gauge | Requests that hold one of the `SQL_FS_MAX_INGRESS_REQUESTS` permits. A permit stays held until the response finishes. |
| `sql_fs_ingress_queued_requests` | gauge | Requests that wait for a permit. |
| `sql_fs_ingress_refused_total` | counter | Requests that failed with `EWORKER_BUSY` (503) at ingress. It counts a full queue, a wait that ran out and a body that did not fit the byte budget. It does not count MCP listeners. |
| `sql_fs_ingress_queue_timeouts_total` | counter | The part of `sql_fs_ingress_refused_total` whose wait passed `SQL_FS_MAX_INGRESS_WAIT_MS`. |
| `sql_fs_ingress_retained_raw_bytes` | gauge | Request-body bytes that admitted requests hold, counted against `SQL_FS_MAX_INGRESS_BYTES`. |
| `sql_fs_ingress_payload_too_large_total` | counter | Requests that failed with 413 because the body passed its limit. More replicas do not help. |
| `sql_fs_ingress_aborted_total` | counter | Requests whose client disconnected before the server finished. |
| `sql_fs_ingress_mcp_listeners_active` | gauge | Open `GET /mcp` streams. |
| `sql_fs_ingress_mcp_listeners_queued` | gauge | `GET /mcp` streams that wait for a listener permit. |
| `sql_fs_ingress_mcp_listeners_refused_total` | counter | `GET /mcp` streams that failed with 503. |
| `sql_fs_ingress_mcp_listeners_queue_timeouts_total` | counter | The part of `sql_fs_ingress_mcp_listeners_refused_total` whose wait ran out. |

Ingress has no wait histogram. Use `sql_fs_ingress_queued_requests` and the refusal counters.

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

The p95 cannot pass `SQL_FS_WORKER_QUEUE_WAIT_MS`, because a request that waits longer is refused and not recorded. A p95 at the limit means the histogram is saturated, not that the wait is bounded. The top finite bucket is 1000 ms. If you raise `SQL_FS_WORKER_QUEUE_WAIT_MS` above 1000 ms, quantiles above 1000 ms report 1000.

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

For example, a peak of 300 execs per second from many tenants needs 300 / 100 = 3 replicas, and 5 with headroom. If one tenant runs 6 execs at a time, 5 replicas with the default limit of 1 is too few. That tenant needs 6 replicas, or 3 or more replicas that each run 4 workers with a limit of 2. A replica with 4 workers needs its memory sized again.

## Doing it well

- Run at least 2 replicas. A single replica drops all traffic while it restarts or drains.
- Configure Redis before you run more than one replica. `REDIS_URL` carries the sandbox locks. The [README](../README.md#deploy-with-docker) describes the multi-replica setup.
- Scale out fast and scale in slowly. A short burst of refusals should add replicas within a minute. Removing replicas should wait for several minutes of low load, so that the count does not swing.
- Let a replica drain before it stops. A script that is cut off mid-run has an unknown outcome, and the client gets no result.
- Make clients retry. Retry a 503 with `retryable: true` after `Retry-After`, with jitter. Also retry connection errors on large uploads, because a client can see a refused upload as a socket error (`UND_ERR_SOCKET`) instead of the 503. Never retry `EEXEC_OUTCOME_UNKNOWN` automatically.
- Size the caps for each box size and keep them fixed. Do not change worker counts, output caps or ingress limits at runtime to absorb load. Add replicas instead. The memory measurements in [CONFIGURATION.md](CONFIGURATION.md#sizing) hold only for the caps they were taken with.

### Shutdown and draining

On `SIGTERM` or `SIGINT`, the server does the following:

1. It closes ingress admission. Queued requests, and new requests on open connections, get 503 `ESHUTTINGDOWN` with `Retry-After: 1`. Admitted requests continue.
2. It ends every MCP session's `GET /mcp` listener stream. In-flight MCP tool calls continue.
3. It stops accepting connections and waits for open requests to finish.
4. It closes MCP sessions, then lets running worker operations finish for up to 30 s, then closes Postgres and Redis. It exits with code 0.
5. If shutdown has not finished 60 s after the signal, it logs `shutdown_force_exit` and exits with code 1.

Neither the 30 s nor the 60 s limit is configurable. A script can run for up to `SQL_FS_WORKER_EXECUTION_MS`, 120 s by default, so a long script can still be cut off. Set the platform's termination grace period above 60 s so that the platform does not kill the process before the server's own limit. To avoid cut-off scripts, keep `SQL_FS_WORKER_EXECUTION_MS` below about 60 s.

### Wait limits

A request can wait twice before it gets a 503. It first waits for an ingress permit, up to `SQL_FS_MAX_INGRESS_WAIT_MS`. An exec then waits for a worker, up to `SQL_FS_WORKER_QUEUE_WAIT_MS`. Both default to 250 ms, so an exec can queue for up to 0.5 s before it fails.

A longer ingress wait does not absorb bursts. The ingress queue holds at most as many requests as ingress admits at once: `SQL_FS_MAX_INGRESS_REQUESTS` for the replica and `SQL_FS_MAX_INGRESS_TENANT_REQUESTS` for each tenant, 8 and 4 by default. In a burst of 100 requests spread across tenants, 8 run, 8 wait and the rest are refused at once, whatever the wait. One tenant on its own gets 4 running and 4 waiting. The wait only decides how long those few queued requests hold their places. [#269](https://github.com/Hazzng/sql-fs/issues/269) tracks a deeper ingress queue.

These runs used the same 2 GiB replica as [Measured capacity](#measured-capacity), with clients that waited 1 s after each 503, as `Retry-After: 1` asks. They ran on 2026-10-17.

| Load | `SQL_FS_MAX_INGRESS_WAIT_MS=250` | `SQL_FS_MAX_INGRESS_WAIT_MS=1000` |
|---|---|---|
| 100 agents start at once, 10 tenants | 83 refusals | 83 refusals |
| One tenant, about 100 execs/s offered, three 30 s runs: refusals | 317, 385, 395 | 403, 479, 414 |
| The same runs: successful execs/s | 74.5, 69.8, 68.5 | 67.8, 63.4, 67.2 |
| The same runs: p99 latency | 123, 151, 174 ms | 246, 283, 173 ms |

The longer wait refused as many requests in the burst, and slightly more under sustained overload, with higher tail latency. Keep the default. Raise the wait only if your clients cannot retry, and add replicas for any load that refuses requests for more than a burst.

## Example: Azure Container Apps

`deploy/azure/aca.yaml` deploys sql-fs to Azure Container Apps. Its scale rule targets 50 concurrent requests for each replica. One replica admits only 8 requests by default and runs 2 operations at a time, so that rule starts adding replicas long after requests begin to fail. The example below shows only the fields to change. Merge them into the `template` block of `aca.yaml`, which keeps the image, environment and probes. It is a starting point, not a tested configuration.

```yaml
template:
  terminationGracePeriodSeconds: 90
  containers:
    - name: api
      resources:
        cpu: 2.0
        memory: 4Gi
  scale:
    minReplicas: 2
    maxReplicas: 10
    rules:
      - name: concurrent-requests
        http:
          metadata:
            concurrentRequests: "4"
      - name: worker-refusals
        custom:
          type: prometheus
          metadata:
            serverAddress: http://prometheus.example.internal:9090
            query: sum(rate(sql_fs_ingress_refused_total[2m])) + sum(rate(sql_fs_worker_refused_total[2m]))
            threshold: "1"
```

The HTTP rule needs no Prometheus. It scales on concurrent requests, which track the ingress and worker gates. Set `concurrentRequests` to about the worker count plus the queue you accept. Use 4 for short execs with 2 workers. Use a value closer to the worker count when scripts run for seconds.

The `prometheus` rule is a KEDA scaler. It needs a Prometheus server that scrapes every replica with the token from [Endpoints](#endpoints). It asks for one replica for each refusal per second. Container Apps uses the highest replica count that any rule asks for. Once refusals stop, this rule asks for none, so the HTTP rule holds the steady count.

On the Consumption plan, CPU and memory come in fixed pairs, and 2 CPUs come with 4 GiB. The measured capacity above used 2 CPUs and 2 GiB.
