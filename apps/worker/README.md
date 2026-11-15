# Durable Outbox Worker

The worker package implements the Phase 5 durable outbox processing engine with a reviewable repository seam, bounded leases, crash recovery, backoff retry, dead-letter queueing, and queue health telemetry.

## Architecture and Seam

The worker engine is decoupled from database storage through the `OutboxRepository` interface (`src/outbox-types.ts`):

- **Bounded lease claims**: `claimBatch({ workerId, batchSize, leaseDurationMs })` claims ready events using `FOR UPDATE SKIP LOCKED`. Active leases guarantee mutual exclusion across multiple workers.
- **Crash-safe lease recovery**: If a worker process terminates abruptly before completing an event, its lease expires at `lease_expires_at`. Other workers automatically reclaim expired leases without manual intervention or orphaned events.
- **Retry with exponential backoff & jitter**: `BackoffPolicy` computes exponential delays (`initialDelay * factor^retries`) bounded by `maxDelayMs`, with jitter to prevent stampedes.
- **Dead-letter queueing**: When failures exceed `maxRetries`, events transition into `dead_lettered_at` with a recorded `dead_letter_reason` and `last_error`, removing poison pills from active polling.
- **At-least-once & idempotency contracts**: Outbox delivery guarantees at-least-once processing. Consumers deduplicate events using `createIdempotentHandler` and an `IdempotencyStore`, preventing repeated side-effects upon redelivery.
- **Queue health metrics**: `getQueueHealth(workspaceId?)` reports pending, in-flight, dead-letter, and delivered counts, along with `oldestPendingAgeMs` and `queueLagMs`.
- **Lifecycle shutdown**: Integrates with `runWorker` from `worker-lifecycle.ts`. Upon `SIGINT`/`SIGTERM`, the polling loop halts and waits for in-flight tasks to drain cleanly.

## Running Tests

Run worker unit tests:
```powershell
docker compose run --rm --no-deps api bun run --filter @ticketing/worker test
```

Run PostgreSQL integration tests:
```powershell
docker compose -p outbox-worker-slice --profile test run --rm --no-deps -e TEST_DATABASE_URL=postgres://ticketing_test:local-test-only@db-test:5432/ticketing_test api bun run --filter @ticketing/api test:integration
```
