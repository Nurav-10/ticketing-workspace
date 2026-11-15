import { randomUUID } from 'node:crypto';
import type {
  ClaimLeaseOptions,
  CreateOutboxEventInput,
  OutboxEventRecord,
  OutboxRepository,
  QueueHealthMetrics,
  RecordFailureOptions,
} from './outbox-types.js';

/**
 * In-memory OutboxRepository for testing and standalone execution.
 * Faithfully mirrors PostgreSQL FOR UPDATE SKIP LOCKED concurrency and lease expiration semantics.
 */
export class InMemoryOutboxRepository implements OutboxRepository {
  private events: OutboxEventRecord[] = [];
  private workspaceSequences = new Map<string, bigint>();
  private clockOffsetMs = 0;

  get now(): Date {
    return new Date(Date.now() + this.clockOffsetMs);
  }

  advanceClock(ms: number): void {
    this.clockOffsetMs += ms;
  }

  async claimBatch(options: ClaimLeaseOptions): Promise<OutboxEventRecord[]> {
    const currentTime = this.now;
    const claimed: OutboxEventRecord[] = [];

    // Filter ready events: pending, not dead-lettered, nextAttemptAt due, unleased or expired lease
    const eligible = this.events
      .filter((ev) => {
        if (options.workspaceId && ev.workspaceId !== options.workspaceId) return false;
        if (ev.deliveredAt !== null || ev.deadLetteredAt !== null) return false;
        if (ev.nextAttemptAt > currentTime) return false;
        if (ev.leaseExpiresAt !== null && ev.leaseExpiresAt > currentTime) return false;
        return true;
      })
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());

    for (const ev of eligible) {
      if (claimed.length >= options.batchSize) break;
      ev.claimedBy = options.workerId;
      ev.leaseExpiresAt = new Date(currentTime.getTime() + options.leaseDurationMs);
      claimed.push({ ...ev });
    }

    return claimed;
  }

  async markDelivered(eventId: string): Promise<void> {
    const ev = this.events.find((e) => e.id === eventId);
    if (!ev) throw new Error(`Event ${eventId} not found`);
    ev.deliveredAt = this.now;
    ev.claimedBy = null;
    ev.leaseExpiresAt = null;
  }

  async recordFailure(options: RecordFailureOptions): Promise<void> {
    const ev = this.events.find((e) => e.id === options.eventId);
    if (!ev) throw new Error(`Event ${options.eventId} not found`);

    ev.retryCount += 1;
    ev.lastError = options.error;
    ev.claimedBy = null;
    ev.leaseExpiresAt = null;

    if (options.deadLetter) {
      ev.deadLetteredAt = this.now;
      ev.deadLetterReason = options.deadLetterReason ?? 'Max retries exceeded';
    } else if (options.nextAttemptAt) {
      ev.nextAttemptAt = options.nextAttemptAt;
    }
  }

  async getQueueHealth(workspaceId?: string | undefined): Promise<QueueHealthMetrics> {
    const currentTime = this.now;
    const relevant = workspaceId
      ? this.events.filter((e) => e.workspaceId === workspaceId)
      : this.events;

    let pendingCount = 0;
    let inFlightCount = 0;
    let deadLetterCount = 0;
    let deliveredCount = 0;
    let oldestPendingTime: Date | null = null;
    let earliestPendingNextAttempt: Date | null = null;

    for (const ev of relevant) {
      if (ev.deliveredAt !== null) {
        deliveredCount += 1;
      } else if (ev.deadLetteredAt !== null) {
        deadLetterCount += 1;
      } else {
        pendingCount += 1;
        if (ev.leaseExpiresAt !== null && ev.leaseExpiresAt > currentTime) {
          inFlightCount += 1;
        }
        if (!oldestPendingTime || ev.createdAt < oldestPendingTime) {
          oldestPendingTime = ev.createdAt;
        }
        if (!earliestPendingNextAttempt || ev.nextAttemptAt < earliestPendingNextAttempt) {
          earliestPendingNextAttempt = ev.nextAttemptAt;
        }
      }
    }

    const oldestPendingAgeMs = oldestPendingTime
      ? Math.max(0, currentTime.getTime() - oldestPendingTime.getTime())
      : 0;

    const queueLagMs = earliestPendingNextAttempt
      ? Math.max(0, currentTime.getTime() - earliestPendingNextAttempt.getTime())
      : 0;

    return {
      pendingCount,
      inFlightCount,
      deadLetterCount,
      deliveredCount,
      oldestPendingAgeMs,
      queueLagMs,
    };
  }

  async insertEvent(input: CreateOutboxEventInput): Promise<OutboxEventRecord> {
    const currentTime = this.now;
    const currentSeq = this.workspaceSequences.get(input.workspaceId) ?? 1n;
    this.workspaceSequences.set(input.workspaceId, currentSeq + 1n);

    const record: OutboxEventRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      issueId: input.issueId,
      eventKind: input.eventKind,
      schemaVersion: input.schemaVersion ?? 1,
      payload: input.payload,
      createdAt: currentTime,
      deliveredAt: null,
      retryCount: 0,
      nextAttemptAt: currentTime,
      claimedBy: null,
      leaseExpiresAt: null,
      deadLetteredAt: null,
      deadLetterReason: null,
      lastError: null,
      workspaceSequence: currentSeq,
    };

    this.events.push(record);
    return { ...record };
  }

  getEvents(): readonly OutboxEventRecord[] {
    return this.events.map((e) => ({ ...e }));
  }

  clear(): void {
    this.events = [];
    this.workspaceSequences.clear();
    this.clockOffsetMs = 0;
  }
}
