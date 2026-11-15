/**
 * Core event and persistence contracts for the durable outbox worker.
 */

export interface OutboxEventRecord {
  id: string;
  workspaceId: string;
  teamId: string;
  issueId: string;
  eventKind: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  createdAt: Date;
  deliveredAt: Date | null;
  retryCount: number;
  nextAttemptAt: Date;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  deadLetteredAt: Date | null;
  deadLetterReason: string | null;
  lastError: string | null;
  workspaceSequence: bigint | null;
}

export interface ClaimLeaseOptions {
  workerId: string;
  batchSize: number;
  leaseDurationMs: number;
  workspaceId?: string | undefined;
}

export interface RecordFailureOptions {
  eventId: string;
  error: string;
  nextAttemptAt?: Date | undefined;
  deadLetter?: boolean | undefined;
  deadLetterReason?: string | undefined;
}

export interface QueueHealthMetrics {
  pendingCount: number;
  inFlightCount: number;
  deadLetterCount: number;
  deliveredCount: number;
  oldestPendingAgeMs: number;
  queueLagMs: number;
}

export interface CreateOutboxEventInput {
  workspaceId: string;
  teamId: string;
  issueId: string;
  eventKind: string;
  payload: Record<string, unknown>;
  schemaVersion?: number | undefined;
}

export interface EventHandlerContext {
  event: OutboxEventRecord;
  workerId: string;
  attemptNumber: number;
  signal: AbortSignal;
}

export type EventHandler = (context: EventHandlerContext) => Promise<void>;

/**
 * Repository seam decoupling outbox worker processing from underlying database storage.
 */
export interface OutboxRepository {
  /**
   * Claims up to batchSize ready events using bounded leases.
   * Concurrency-safe across multiple workers.
   * Automatically reclaims expired leases from dead/crashed workers.
   */
  claimBatch(options: ClaimLeaseOptions): Promise<OutboxEventRecord[]>;

  /**
   * Marks an event as successfully delivered. Terminal state; clears lease.
   */
  markDelivered(eventId: string): Promise<void>;

  /**
   * Records processing failure. If deadLetter is true, transitions to dead letter queue.
   * Otherwise increments retryCount, schedules nextAttemptAt, and clears lease.
   */
  recordFailure(options: RecordFailureOptions): Promise<void>;

  /**
   * Computes queue lag, oldest pending age, and count distribution.
   */
  getQueueHealth(workspaceId?: string | undefined): Promise<QueueHealthMetrics>;

  /**
   * Persists an outbox event, allocating per-workspace sequence under lock if supported.
   */
  insertEvent(input: CreateOutboxEventInput): Promise<OutboxEventRecord>;
}
