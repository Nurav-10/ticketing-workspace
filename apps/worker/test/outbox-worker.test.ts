import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OutboxWorker } from '../src/outbox-worker.js';
import { InMemoryOutboxRepository } from '../src/in-memory-outbox-repository.js';
import { BackoffPolicy } from '../src/backoff.js';
import { InMemoryIdempotencyStore, createIdempotentHandler } from '../src/idempotency.js';
import type { CreateOutboxEventInput } from '../src/outbox-types.js';

function createSampleEvent(overrides: Partial<CreateOutboxEventInput> = {}): CreateOutboxEventInput {
  const issueId = randomUUID();
  return {
    workspaceId: randomUUID(),
    teamId: randomUUID(),
    issueId,
    eventKind: 'issue.created',
    payload: { issue_id: issueId, version: 1 },
    ...overrides,
  };
}

test('OutboxWorker claims bounded batches and marks delivered', async () => {
  const repo = new InMemoryOutboxRepository();
  for (let i = 0; i < 5; i++) {
    await repo.insertEvent(createSampleEvent());
  }

  const deliveredEvents: string[] = [];
  const worker = new OutboxWorker(repo, {
    batchSize: 3,
    leaseDurationMs: 10_000,
  });

  worker.registerDefaultHandler(async ({ event }) => {
    deliveredEvents.push(event.id);
  });

  // First batch claims up to batchSize (3)
  const processedFirst = await worker.processBatch();
  expect(processedFirst).toBe(3);
  expect(deliveredEvents.length).toBe(3);

  // Check queue health
  const healthAfterFirst = await repo.getQueueHealth();
  expect(healthAfterFirst.deliveredCount).toBe(3);
  expect(healthAfterFirst.pendingCount).toBe(2);

  // Second batch processes the remaining 2
  const processedSecond = await worker.processBatch();
  expect(processedSecond).toBe(2);
  expect(deliveredEvents.length).toBe(5);

  const finalHealth = await repo.getQueueHealth();
  expect(finalHealth.deliveredCount).toBe(5);
  expect(finalHealth.pendingCount).toBe(0);
});

test('Crash-safe recovery: expired leases from a dead worker are reclaimed', async () => {
  const repo = new InMemoryOutboxRepository();
  const event = await repo.insertEvent(createSampleEvent());

  // Worker 1 claims the event with a 5-second lease, then "crashes" (does not settle)
  const claimedByWorker1 = await repo.claimBatch({
    workerId: 'worker-1',
    batchSize: 10,
    leaseDurationMs: 5_000,
  });
  expect(claimedByWorker1.length).toBe(1);
  expect(claimedByWorker1[0]?.claimedBy).toBe('worker-1');

  // Immediately, Worker 2 cannot claim it because the lease is active
  const earlyWorker2 = await repo.claimBatch({
    workerId: 'worker-2',
    batchSize: 10,
    leaseDurationMs: 5_000,
  });
  expect(earlyWorker2.length).toBe(0);

  // Advance time past the 5-second lease duration
  repo.advanceClock(5_001);

  // Worker 2 now automatically reclaims the expired lease
  const deliveredByWorker2: string[] = [];
  const worker2 = new OutboxWorker(repo, {
    workerId: 'worker-2',
    batchSize: 10,
    leaseDurationMs: 5_000,
  });
  worker2.registerDefaultHandler(async ({ event: ev }) => {
    deliveredByWorker2.push(ev.id);
  });

  const processed = await worker2.processBatch();
  expect(processed).toBe(1);
  expect(deliveredByWorker2).toEqual([event.id]);

  const health = await repo.getQueueHealth();
  expect(health.deliveredCount).toBe(1);
  expect(health.pendingCount).toBe(0);
});

test('Retry and exponential backoff: failed handler schedules next attempt', async () => {
  const repo = new InMemoryOutboxRepository();
  const event = await repo.insertEvent(createSampleEvent());

  const backoffPolicy = new BackoffPolicy({
    initialDelayMs: 2_000,
    factor: 2,
    maxRetries: 3,
    jitterFactor: 0,
  });

  let shouldFail = true;
  let attempts = 0;

  const worker = new OutboxWorker(repo, {
    batchSize: 1,
    leaseDurationMs: 10_000,
    backoffPolicy,
  });

  worker.registerDefaultHandler(async () => {
    attempts += 1;
    if (shouldFail) {
      throw new Error('Transient service failure');
    }
  });

  // Attempt 1 fails
  await worker.processBatch();
  expect(attempts).toBe(1);

  // Immediate next claim yields 0 because nextAttemptAt is 2000ms in future
  const immediateClaim = await worker.processBatch();
  expect(immediateClaim).toBe(0);

  // Advance clock by 1000ms (still not ready)
  repo.advanceClock(1_000);
  expect(await worker.processBatch()).toBe(0);

  // Advance clock past 2000ms (now ready for retry)
  repo.advanceClock(1_001);
  shouldFail = false; // Resolved

  await worker.processBatch();
  expect(attempts).toBe(2);

  const health = await repo.getQueueHealth();
  expect(health.deliveredCount).toBe(1);
  expect(health.pendingCount).toBe(0);
});

test('Dead-letter handling: transitions to dead-letter queue when max retries exceeded', async () => {
  const repo = new InMemoryOutboxRepository();
  const event = await repo.insertEvent(createSampleEvent());

  const backoffPolicy = new BackoffPolicy({
    initialDelayMs: 100,
    factor: 2,
    maxRetries: 2,
    jitterFactor: 0,
  });

  const worker = new OutboxWorker(repo, {
    batchSize: 1,
    leaseDurationMs: 1_000,
    backoffPolicy,
  });

  worker.registerDefaultHandler(async () => {
    throw new Error('Permanent poison pill error');
  });

  // Attempt 1 (retryCount -> 1)
  await worker.processBatch();
  let health = await repo.getQueueHealth();
  expect(health.pendingCount).toBe(1);
  expect(health.deadLetterCount).toBe(0);

  // Advance clock past backoff and attempt 2 (retryCount -> 2)
  repo.advanceClock(150);
  await worker.processBatch();
  health = await repo.getQueueHealth();
  expect(health.pendingCount).toBe(1);
  expect(health.deadLetterCount).toBe(0);

  // Advance clock past backoff and attempt 3 (exceeds maxRetries 2 -> dead letter)
  repo.advanceClock(300);
  await worker.processBatch();

  health = await repo.getQueueHealth();
  expect(health.pendingCount).toBe(0);
  expect(health.deadLetterCount).toBe(1);

  const allEvents = repo.getEvents();
  const deadEvent = allEvents.find((e) => e.id === event.id);
  expect(deadEvent?.deadLetteredAt).not.toBeNull();
  expect(deadEvent?.deadLetterReason).toContain('Exceeded max retries (2)');
  expect(deadEvent?.lastError).toBe('Permanent poison pill error');

  // Verify it is never claimed again even if clock advances
  repo.advanceClock(100_000);
  const claimAfterDead = await worker.processBatch();
  expect(claimAfterDead).toBe(0);
});

test('At-least-once delivery with consumer idempotency deduplication', async () => {
  const repo = new InMemoryOutboxRepository();
  const store = new InMemoryIdempotencyStore();
  const event = await repo.insertEvent(createSampleEvent());

  const sideEffects: string[] = [];
  const rawHandler = async ({ event: ev }: { event: typeof event }) => {
    sideEffects.push(`processed:${ev.id}`);
  };

  const idempotentHandler = createIdempotentHandler(store, 'notifications-group', rawHandler);

  const worker = new OutboxWorker(repo);
  worker.registerDefaultHandler(idempotentHandler);

  // Normal first delivery
  await worker.processBatch();
  expect(sideEffects).toEqual([`processed:${event.id}`]);

  // Simulate redelivery (at-least-once contract, e.g. after crash before lease release)
  // We reset deliveredAt to simulate redelivery
  const eventRecord = repo.getEvents().find((e) => e.id === event.id)!;
  eventRecord.deliveredAt = null;
  eventRecord.leaseExpiresAt = null;

  // Redelivery: consumer deduplicates and avoids second side-effect
  await worker.processBatch();
  expect(sideEffects.length).toBe(1); // Still only 1 side effect executed!
});

test('Graceful shutdown with in-flight drain on AbortSignal', async () => {
  const repo = new InMemoryOutboxRepository();
  for (let i = 0; i < 3; i++) {
    await repo.insertEvent(createSampleEvent());
  }

  const controller = new AbortController();
  const worker = new OutboxWorker(repo, {
    batchSize: 3,
    pollIntervalMs: 50,
  });

  let inFlightObserved = 0;
  worker.registerDefaultHandler(async () => {
    inFlightObserved = worker.inFlightCount;
    // Simulate short processing
    await new Promise((r) => setTimeout(r, 60));
  });

  const workerPromise = worker.start(controller.signal);

  // Let worker start processing the batch
  await new Promise((r) => setTimeout(r, 20));
  // Request abort mid-flight
  controller.abort();

  // Wait for worker to settle and drain
  await workerPromise;

  expect(worker.inFlightCount).toBe(0);
  expect(inFlightObserved).toBeGreaterThan(0);

  const health = await repo.getQueueHealth();
  expect(health.deliveredCount).toBe(3);
});

test('Multi-worker concurrency: workers claim distinct disjoint batches', async () => {
  const repo = new InMemoryOutboxRepository();
  const count = 20;
  for (let i = 0; i < count; i++) {
    await repo.insertEvent(createSampleEvent());
  }

  const worker1Delivered: string[] = [];
  const worker2Delivered: string[] = [];

  const worker1 = new OutboxWorker(repo, { workerId: 'worker-A', batchSize: 5 });
  const worker2 = new OutboxWorker(repo, { workerId: 'worker-B', batchSize: 5 });

  worker1.registerDefaultHandler(async ({ event }) => {
    worker1Delivered.push(event.id);
  });
  worker2.registerDefaultHandler(async ({ event }) => {
    worker2Delivered.push(event.id);
  });

  // Run both workers concurrently in parallel loops until queue is drained
  while ((await repo.getQueueHealth()).pendingCount > 0) {
    await Promise.all([worker1.processBatch(), worker2.processBatch()]);
  }

  expect(worker1Delivered.length + worker2Delivered.length).toBe(count);

  // Verify mutually exclusive claims (no overlap)
  const set1 = new Set(worker1Delivered);
  for (const id of worker2Delivered) {
    expect(set1.has(id)).toBe(false);
  }

  const health = await repo.getQueueHealth();
  expect(health.deliveredCount).toBe(count);
  expect(health.pendingCount).toBe(0);
});

test('Queue health metrics report accurate lag and oldest pending age', async () => {
  const repo = new InMemoryOutboxRepository();
  const ws1 = randomUUID();
  const ws2 = randomUUID();

  // Insert event 1 in ws1
  await repo.insertEvent(createSampleEvent({ workspaceId: ws1 }));

  // Advance 5000 ms
  repo.advanceClock(5_000);

  // Insert event 2 in ws2
  await repo.insertEvent(createSampleEvent({ workspaceId: ws2 }));

  // Advance 2000 ms
  repo.advanceClock(2_000);

  const globalHealth = await repo.getQueueHealth();
  expect(globalHealth.pendingCount).toBe(2);
  // Oldest event is event 1: age is at least 5000 + 2000 = 7000 ms
  expect(globalHealth.oldestPendingAgeMs).toBeGreaterThanOrEqual(7_000);
  expect(globalHealth.oldestPendingAgeMs).toBeLessThan(7_200);
  expect(globalHealth.queueLagMs).toBeGreaterThanOrEqual(7_000);
  expect(globalHealth.queueLagMs).toBeLessThan(7_200);

  // Scoped to ws2: oldest event is at least 2000 ms
  const ws2Health = await repo.getQueueHealth(ws2);
  expect(ws2Health.pendingCount).toBe(1);
  expect(ws2Health.oldestPendingAgeMs).toBeGreaterThanOrEqual(2_000);
  expect(ws2Health.oldestPendingAgeMs).toBeLessThan(2_200);
});
