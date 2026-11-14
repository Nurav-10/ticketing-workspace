import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type {
  AuthenticateSessionRecord,
  CreateSessionRecord,
  CreatedSession,
  SessionRepository,
} from './session-repository.js';

interface CreatedSessionRow {
  id: string;
  userId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

interface AuthenticatedSessionRow {
  sessionId: string;
  userId: string;
}

function assertHash(tokenHash: Buffer): void {
  if (tokenHash.byteLength !== 32) throw new Error('Invalid session token hash');
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid session duration');
}

/** Prisma/PostgreSQL adapter. Raw SQL is limited to operations needing row locks and DB time. */
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(record: CreateSessionRecord): Promise<CreatedSession> {
    assertHash(record.tokenHash);
    assertDuration(record.idleTimeoutMs);
    assertDuration(record.absoluteTimeoutMs);
    if (record.idleTimeoutMs > record.absoluteTimeoutMs) throw new Error('Invalid session lifetime');

    const rows = await this.prisma.$queryRaw<CreatedSessionRow[]>`
      WITH operation_time AS MATERIALIZED (
        SELECT clock_timestamp() AS now
      )
      INSERT INTO app_sessions (
        user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at
      )
      SELECT
        u.id,
        ${record.tokenHash},
        t.now,
        t.now,
        t.now + (${record.idleTimeoutMs}::double precision * INTERVAL '1 millisecond'),
        t.now + (${record.absoluteTimeoutMs}::double precision * INTERVAL '1 millisecond')
      FROM users AS u
      CROSS JOIN operation_time AS t
      WHERE u.id = ${record.userId}::uuid
        AND u.status = 'active'
      RETURNING
        id::text AS id,
        user_id::text AS "userId",
        idle_expires_at AS "idleExpiresAt",
        absolute_expires_at AS "absoluteExpiresAt"
    `;

    const created = rows[0];
    if (!created) throw new Error('Cannot issue a session for an inactive or missing user');
    return created;
  }

  async authenticate(record: AuthenticateSessionRecord): Promise<{ userId: string; sessionId: string } | null> {
    assertHash(record.tokenHash);
    assertDuration(record.idleTimeoutMs);
    assertDuration(record.touchIntervalMs);
    if (record.touchIntervalMs >= record.idleTimeoutMs) throw new Error('Invalid session touch interval');

    return this.prisma.$transaction(async (tx) => {
      // Lock the session row before sampling time. A prior committed revoke is observed
      // by the next statement; a concurrent revoke waits until this lookup completes.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM app_sessions
        WHERE token_hash = ${record.tokenHash}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      // clock_timestamp() is evaluated only after the lock is acquired. Eligibility and
      // idle refresh then use this one DB instant, preserving the exact expiry boundary.
      const rows = await tx.$queryRaw<AuthenticatedSessionRow[]>`
        WITH operation_time AS MATERIALIZED (
          SELECT clock_timestamp() AS now
        ), eligible AS MATERIALIZED (
          SELECT
            s.id,
            s.user_id,
            s.last_seen_at,
            s.absolute_expires_at,
            t.now
          FROM app_sessions AS s
          JOIN users AS u ON u.id = s.user_id
          CROSS JOIN operation_time AS t
          WHERE s.token_hash = ${record.tokenHash}
            AND s.revoked_at IS NULL
            AND s.idle_expires_at > t.now
            AND s.absolute_expires_at > t.now
            AND u.status = 'active'
        ), touched AS (
          UPDATE app_sessions AS s
          SET last_seen_at = e.now,
              idle_expires_at = LEAST(
                e.now + (${record.idleTimeoutMs}::double precision * INTERVAL '1 millisecond'),
                s.absolute_expires_at
              )
          FROM eligible AS e
          WHERE s.id = e.id
            AND e.last_seen_at <= e.now - (${record.touchIntervalMs}::double precision * INTERVAL '1 millisecond')
          RETURNING s.id
        )
        SELECT e.id::text AS "sessionId", e.user_id::text AS "userId"
        FROM eligible AS e
      `;
      return rows[0] ?? null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async revoke(tokenHash: Buffer): Promise<void> {
    assertHash(tokenHash);
    // UPDATE obtains the row lock and uses one database timestamp; already-revoked and
    // unknown tokens are intentionally equivalent, making logout idempotent.
    await this.prisma.$executeRaw`
      UPDATE app_sessions
      SET revoked_at = clock_timestamp()
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
    `;
  }
}
