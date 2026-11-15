import { randomUUID } from 'node:crypto';
import { BackoffPolicy } from './backoff.js';
import type {
  EventHandler,
  EventHandlerContext,
  OutboxEventRecord,
  OutboxRepository,
  QueueHealthMetrics,
} from './outbox-types.js';

export interface OutboxWorkerOptions {
  workerId?: string | undefined;
  batchSize?: number | undefined;
  pollIntervalMs?: number | undefined;
  leaseDurationMs?: number | undefined;
  concurrency?: number | undefined;
  workspaceId?: string | undefined;
  backoffPolicy?: BackoffPolicy | undefined;
  onEventDelivered?: ((event: OutboxEventRecord) => void) | undefined;
  onEventFailed?: ((event: OutboxEventRecord, error: Error, deadLetter: boolean) => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
}

/**
 * Durable outbox worker engine.
 * - Claims bounded batches with mutual-exclusion leases.
 * - Applies crash-safe exponential retry and dead-letter handling.
 * - Adheres to at-least-once contracts.
 * - Drains in-flight work cleanly on shutdown signals.
 */
export class OutboxWorker {
  readonly workerId: string;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly concurrency: number;
  readonly workspaceId?: string | undefined;
  readonly backoffPolicy: BackoffPolicy;

  private readonly handlers = new Map<string, EventHandler>();
  private defaultHandler?: EventHandler | undefined;
  private inFlight = 0;
  private isRunning = false;

  constructor(
    private readonly repository: OutboxRepository,
    options: OutboxWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.batchSize = options.batchSize ?? 10;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.concurrency = options.concurrency ?? 5;
    this.workspaceId = options.workspaceId;
    this.backoffPolicy = options.backoffPolicy ?? new BackoffPolicy();
    this.onEventDelivered = options.onEventDelivered;
    this.onEventFailed = options.onEventFailed;
    this.onError = options.onError;
  }

  private readonly onEventDelivered?: ((event: OutboxEventRecord) => void) | undefined;
  private readonly onEventFailed?: ((event: OutboxEventRecord, error: Error, deadLetter: boolean) => void) | undefined;
  private readonly onError?: ((error: Error) => void) | undefined;

  registerHandler(eventKind: string, handler: EventHandler): this {
    this.handlers.set(eventKind, handler);
    return this;
  }

  registerDefaultHandler(handler: EventHandler): this {
    this.defaultHandler = handler;
    return this;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  get running(): boolean {
    return this.isRunning;
  }

  async getQueueHealth(workspaceId?: string | undefined): Promise<QueueHealthMetrics> {
    return this.repository.getQueueHealth(workspaceId);
  }

  /**
   * Processes a single claimed batch of events with bounded concurrency.
   * Returns the count of claimed events.
   */
  async processBatch(signal?: AbortSignal | undefined): Promise<number> {
    if (signal?.aborted) return 0;

    let events: OutboxEventRecord[];
    try {
      events = await this.repository.claimBatch({
        workerId: this.workerId,
        batchSize: this.batchSize,
        leaseDurationMs: this.leaseDurationMs,
        workspaceId: this.workspaceId,
      });
    } catch (claimError) {
      this.onError?.(claimError instanceof Error ? claimError : new Error(String(claimError)));
      return 0;
    }

    if (events.length === 0) return 0;

    // Process with bounded concurrency
    const activeTasks: Promise<void>[] = [];
    for (const event of events) {
      if (signal?.aborted) break;

      const task = this.processSingleEvent(event, signal).finally(() => {
        const idx = activeTasks.indexOf(task);
        if (idx !== -1) activeTasks.splice(idx, 1);
      });

      activeTasks.push(task);
      if (activeTasks.length >= this.concurrency) {
        await Promise.race(activeTasks);
      }
    }

    await Promise.all(activeTasks);
    return events.length;
  }

  private async processSingleEvent(event: OutboxEventRecord, signal?: AbortSignal | undefined): Promise<void> {
    this.inFlight += 1;
    const effectiveSignal = signal ?? new AbortController().signal;

    try {
      const handler = this.handlers.get(event.eventKind) ?? this.defaultHandler;
      if (!handler) {
        throw new Error(`No handler registered for event kind: ${event.eventKind}`);
      }

      const context: EventHandlerContext = {
        event,
        workerId: this.workerId,
        attemptNumber: event.retryCount + 1,
        signal: effectiveSignal,
      };

      await handler(context);
      await this.repository.markDelivered(event.id);
      this.onEventDelivered?.(event);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const { nextAttemptAt, deadLetter } = this.backoffPolicy.calculateNextAttempt(event.retryCount);

      try {
        await this.repository.recordFailure({
          eventId: event.id,
          error: error.message,
          nextAttemptAt,
          deadLetter,
          deadLetterReason: deadLetter ? `Exceeded max retries (${this.backoffPolicy.maxRetries}): ${error.message}` : undefined,
        });
      } catch (recordErr) {
        this.onError?.(recordErr instanceof Error ? recordErr : new Error(String(recordErr)));
      }

      this.onEventFailed?.(event, error, deadLetter);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  /**
   * Main worker loop. Observes abort signal and drains in-flight tasks cleanly upon shutdown.
   */
  async start(signal: AbortSignal): Promise<void> {
    this.isRunning = true;

    try {
      while (!signal.aborted) {
        const claimed = await this.processBatch(signal);

        if (claimed === 0 && !signal.aborted) {
          // Sleep until next poll interval or until abort signal triggers
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, this.pollIntervalMs);
            const onAbort = () => {
              clearTimeout(timeout);
              resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
    } finally {
      this.isRunning = false;
      // Wait for any remaining in-flight tasks to settle (drain)
      while (this.inFlight > 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }
}
