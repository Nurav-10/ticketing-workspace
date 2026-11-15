import type { Pool, PoolClient } from 'pg';
import type {
  ClaimLeaseOptions,
  CreateOutboxEventInput,
  OutboxEventRecord,
  OutboxRepository,
  QueueHealthMetrics,
  RecordFailureOptions,
} from './outbox-types.js';

interface OutboxRow {
  id: string;
  workspace_id: string;
  team_id: string;
  issue_id: string;
  event_kind: string;
  schema_version: number;
  payload: Record<string, unknown>;
  created_at: Date;
  delivered_at: Date | null;
  retry_count: number;
  next_attempt_at: Date;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  dead_lettered_at: Date | null;
  dead_letter_reason: string | null;
  last_error: string | null;
  workspace_sequence: string | number | bigint | null;
}

function mapRowToRecord(row: OutboxRow): OutboxEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    issueId: row.issue_id,
    eventKind: row.event_kind,
    schemaVersion: row.schema_version,
    payload: row.payload,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    retryCount: row.retry_count,
    nextAttemptAt: row.next_attempt_at,
    claimedBy: row.claimed_by,
    leaseExpiresAt: row.lease_expires_at,
    deadLetteredAt: row.dead_lettered_at,
    deadLetterReason: row.dead_letter_reason,
    lastError: row.last_error,
    workspaceSequence: row.workspace_sequence !== null ? BigInt(row.workspace_sequence) : null,
  };
}

/**
 * PostgreSQL implementation of the OutboxRepository seam.
 * Uses atomic bounded leases with FOR UPDATE SKIP LOCKED for non-blocking multi-worker concurrency.
 */
export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  async claimBatch(options: ClaimLeaseOptions): Promise<OutboxEventRecord[]> {
    const query = `
      WITH available AS (
        SELECT id
        FROM outbox_events
        WHERE delivered_at IS NULL
          AND dead_lettered_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
          AND next_attempt_at <= clock_timestamp()
          AND ($4::uuid IS NULL OR workspace_id = $4::uuid)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events
      SET claimed_by = $2,
          lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond')
      FROM available
      WHERE outbox_events.id = available.id
      RETURNING
        outbox_events.id,
        outbox_events.workspace_id,
        outbox_events.team_id,
        outbox_events.issue_id,
        outbox_events.event_kind,
        outbox_events.schema_version,
        outbox_events.payload,
        outbox_events.created_at,
        outbox_events.delivered_at,
        outbox_events.retry_count,
        outbox_events.next_attempt_at,
        outbox_events.claimed_by,
        outbox_events.lease_expires_at,
        outbox_events.dead_lettered_at,
        outbox_events.dead_letter_reason,
        outbox_events.last_error,
        outbox_events.workspace_sequence;
    `;

    const result = await this.db.query<OutboxRow>(query, [
      options.batchSize,
      options.workerId,
      options.leaseDurationMs,
      options.workspaceId ?? null,
    ]);

    return result.rows.map(mapRowToRecord);
  }

  async markDelivered(eventId: string): Promise<void> {
    await this.db.query(
      `
      UPDATE outbox_events
      SET delivered_at = clock_timestamp(),
          lease_expires_at = NULL,
          claimed_by = NULL
      WHERE id = $1::uuid AND delivered_at IS NULL;
      `,
      [eventId],
    );
  }

  async recordFailure(options: RecordFailureOptions): Promise<void> {
    if (options.deadLetter) {
      await this.db.query(
        `
        UPDATE outbox_events
        SET retry_count = retry_count + 1,
            dead_lettered_at = clock_timestamp(),
            dead_letter_reason = $2,
            last_error = $3,
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE id = $1::uuid;
        `,
        [options.eventId, options.deadLetterReason ?? 'Max retries exceeded', options.error],
      );
    } else {
      const nextAttempt = options.nextAttemptAt ?? new Date();
      await this.db.query(
        `
        UPDATE outbox_events
        SET retry_count = retry_count + 1,
            next_attempt_at = $2,
            last_error = $3,
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE id = $1::uuid;
        `,
        [options.eventId, nextAttempt, options.error],
      );
    }
  }

  async getQueueHealth(workspaceId?: string | undefined): Promise<QueueHealthMetrics> {
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE delivered_at IS NULL AND dead_lettered_at IS NULL)::int AS pending_count,
        COUNT(*) FILTER (WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND lease_expires_at > clock_timestamp())::int AS in_flight_count,
        COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_letter_count,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered_count,
        COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - MIN(created_at) FILTER (WHERE delivered_at IS NULL AND dead_lettered_at IS NULL))) * 1000, 0)::bigint AS oldest_pending_age_ms,
        COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - MIN(next_attempt_at) FILTER (WHERE delivered_at IS NULL AND dead_lettered_at IS NULL))) * 1000), 0)::bigint AS queue_lag_ms
      FROM outbox_events
      WHERE ($1::uuid IS NULL OR workspace_id = $1::uuid);
    `;

    const result = await this.db.query<{
      pending_count: number;
      in_flight_count: number;
      dead_letter_count: number;
      delivered_count: number;
      oldest_pending_age_ms: string | number;
      queue_lag_ms: string | number;
    }>(query, [workspaceId ?? null]);

    const row = result.rows[0];
    if (!row) {
      return {
        pendingCount: 0,
        inFlightCount: 0,
        deadLetterCount: 0,
        deliveredCount: 0,
        oldestPendingAgeMs: 0,
        queueLagMs: 0,
      };
    }

    return {
      pendingCount: Number(row.pending_count),
      inFlightCount: Number(row.in_flight_count),
      deadLetterCount: Number(row.dead_letter_count),
      deliveredCount: Number(row.delivered_count),
      oldestPendingAgeMs: Number(row.oldest_pending_age_ms),
      queueLagMs: Number(row.queue_lag_ms),
    };
  }

  /**
   * Persists an outbox event, atomically allocating a monotonic per-workspace sequence
   * under a transaction-held lock.
   */
  async insertEvent(input: CreateOutboxEventInput): Promise<OutboxEventRecord> {
    const isPool = 'connect' in this.db && typeof (this.db as Pool).connect === 'function';
    const client = isPool ? await (this.db as Pool).connect() : (this.db as PoolClient);

    const mustRelease = isPool;
    try {
      if (mustRelease) await client.query('BEGIN');

      // Allocate per-workspace sequence under row lock
      const seqResult = await client.query<{ sequence: string | number | bigint }>(
        `
        INSERT INTO workspace_outbox_sequences (workspace_id, next_sequence)
        VALUES ($1::uuid, 2)
        ON CONFLICT (workspace_id) DO UPDATE
          SET next_sequence = workspace_outbox_sequences.next_sequence + 1,
              updated_at = clock_timestamp()
        RETURNING next_sequence - 1 AS sequence;
        `,
        [input.workspaceId],
      );

      const sequence = BigInt(seqResult.rows[0]!.sequence);

      const insertResult = await client.query<OutboxRow>(
        `
        INSERT INTO outbox_events (
          workspace_id,
          team_id,
          issue_id,
          event_kind,
          schema_version,
          payload,
          workspace_sequence
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6::jsonb,
          $7
        )
        RETURNING *;
        `,
        [
          input.workspaceId,
          input.teamId,
          input.issueId,
          input.eventKind,
          input.schemaVersion ?? 1,
          JSON.stringify(input.payload),
          sequence.toString(),
        ],
      );

      if (mustRelease) await client.query('COMMIT');
      return mapRowToRecord(insertResult.rows[0]!);
    } catch (error) {
      if (mustRelease) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (mustRelease) (client as PoolClient).release();
    }
  }
}
