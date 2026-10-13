# Worker ownership

Worker-owner owns the resident filesystem, command outcomes, worker replacement, and durable generation retirement. [SessionManager](../session-manager.ts) coordinates distributed leases, runtime execution, read-only error mapping, and worker requests. [Session owners](../session-manager/README.md) hold the session lifetime, local locks, runtime admission, backend factories, and metadata accounting.

| Source | Responsibility |
| --- | --- |
| [protocol.ts](protocol.ts) | Supported command membership, command-derived replies, handler contracts, and complete effect classification |
| [runtime.ts](runtime.ts) | Resident attachment, generation checks, typed command handlers, physical scope completion, and reply construction |
| [request-outcome.ts](request-outcome.ts) | Request-local dispatch and acknowledgment history, transport uncertainty, lease outcomes, and applied-prefix refusal policy |
| [pool.ts](pool.ts) | Admission reservations, request correlation, worker budgets, termination, replacement, and recovery memoization |
| [admission.ts](admission.ts) | Fair queues and tenant capacity limits |
| [filesystem.ts](filesystem.ts) | Filesystem and script-scope adapters for worker commands |
| [message-budget.ts](message-budget.ts) | Request and reply byte budgets, including unknown outcomes for lost oversized replies |

The pool exposes intent methods. `hasReservation` handles nesting, `markRunning` records execution admission, and `withLease` applies worker outcome policy. `recover(error)` terminates the captured worker and retires its captured durable identity. `leaseLostAfterWork` handles loss detected after the callback returns. Reservation context belongs to each pool instance. Slot generations and history flags are private.

## Command contracts

A command addition requires an explicit entry in `OwnerCommandMap` or its supported filesystem method list. The mapped runtime registry requires a handler with that command's result type. The effect policy requires a classification. Filesystem adapters and callers infer results from the command, so callers cannot choose a reply type.

Command removal includes its handler, effect policy, and callers in the same change. [Compile assertions](../tests/unit/worker-protocol.typecheck.ts) reject missing handlers or policy, incorrect handler results, unsupported commands, and caller-selected reply types. [Policy tests](../tests/unit/worker-protocol.test.ts) check the supported effects.

## Scope and lease policy

[script-scope.ts](../../sql-fs/script-scope.ts) owns callback completion for local and worker scope adapters. Only the opener finalizes. Returned values commit, including nonzero bash results. Body or commit failures trigger best-effort abort while preserving the primary error. A failed begin does not invoke the body.

[engine.ts](../session-runtime/engine.ts) runs lease and input checks inside the execution body. [script-tx.ts](../lib/script-tx.ts) checks the lease inside the route body. Both keep those checks active for borrowed scopes. [script-lease.ts](../lib/script-lease.ts) checks dedicated lease-loss signals. Ordinary execution cancellation remains distinct. Read-only execution bypasses the script scope. The runtime's explicit `endScope` handler physically completes an already-open scope.

## Recovery and replay

A dispatched buffered write creates transport uncertainty without proving commit. Lease-loss replay risk depends on exec dispatch, committed filesystem prefixes, or creating attach dispatch. Exec can produce external effects even in read-only mode.

Runtime refusal after an exec or committed prefix becomes `EEXEC_OUTCOME_UNKNOWN`. A post-exec `ECOHERENCE` is also promoted: the buffered journal may already be committed even though cache reconciliation failed. SessionManager passes that unknown outcome to `recover(error)`, which terminates the captured worker, retires its captured durable identity, and increments `unknownOutcomes`. Creating attach dispatch alone does not trigger runtime-refusal promotion. Acknowledged creation can already count as a committed prefix.

Recovery tasks belong to one reservation and one captured slot generation. Repeated recovery shares the task, including a rejected task. A replacement generation gets its own recovery task. Recovery captures the thread and identity before awaits, terminates before durable retirement, and preserves newer residency. Different shared-reader reservations retain independent histories and recovery tasks.

A worker may commit or send an external request before its reply is lost. Unknown outcomes never trigger automatic replay. For `exec` and `execBatch`, `EDRIVERFAULT`, `ECOHERENCE`, and transport failures after dispatch can mean a write or external request already applied. Inspect sandbox state and reconcile external effects before retrying.

## Verification entry points

The focused command exercises the protocol and transport-driven request history.

```bash
pnpm exec vitest run src/api/tests/unit/worker-protocol.test.ts src/api/tests/unit/worker-request-outcome.test.ts src/api/tests/unit/worker-pool-pressure.test.ts
pnpm typecheck
```

[Worker failure integration tests](../tests/integration/worker-owner.failure.integration.test.ts) cover lost creation, buffered writes, blocked flushes, and committed writes. [Lease error tests](../tests/integration/worker-error-lease.integration.test.ts) cover external effects and nested replacement recovery. [Runtime prefix tests](../tests/integration/worker-runtime-prefix.integration.test.ts) cover refusal after applied work. [Replacement tests](../tests/integration/worker-replacement.integration.test.ts) cover residency and actual worker cleanup. Run `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, and `pnpm build`, then `pnpm test:integration` with disposable Postgres and Redis configured through the test environment.
