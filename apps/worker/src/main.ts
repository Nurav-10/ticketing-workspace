import { runWorker } from './worker-lifecycle.js';
import { OutboxWorker } from './outbox-worker.js';
import { InMemoryOutboxRepository } from './in-memory-outbox-repository.js';
import { BackoffPolicy } from './backoff.js';

// Compose the durable outbox worker with bounded leases and lifecycle signal handling.
// The repository seam allows plugging in PgOutboxRepository or InMemoryOutboxRepository.
const repository = new InMemoryOutboxRepository();
const backoffPolicy = new BackoffPolicy({
  initialDelayMs: 1_000,
  maxDelayMs: 300_000,
  maxRetries: 5,
  factor: 2,
});

const worker = new OutboxWorker(repository, {
  workerId: `worker-${process.pid}`,
  batchSize: 10,
  pollIntervalMs: 1_000,
  leaseDurationMs: 30_000,
  concurrency: 5,
  backoffPolicy,
});

// Register default handler for logging event dispatch
worker.registerDefaultHandler(async ({ event, attemptNumber }) => {
  // Safe default: no-op event acknowledgement in baseline mode
  if (process.env.DEBUG_OUTBOX) {
    console.info(`[OutboxWorker] Processed event ${event.id} (${event.eventKind}) attempt ${attemptNumber}`);
  }
});

await runWorker((signal) => worker.start(signal), process);
