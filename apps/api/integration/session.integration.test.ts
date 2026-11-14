import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaSessionRepository } from '../src/sessions/prisma-session-repository.js';
import { SessionService } from '../src/sessions/session-service.js';
import { pool, prisma } from './test-database.js';

const sessionPolicy = {
  idleTimeoutMs: 60_000,
  absoluteTimeoutMs: 300_000,
  touchIntervalMs: 10_000,
};
const sessionService = new SessionService(new PrismaSessionRepository(prisma), sessionPolicy);

async function createUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, provider_subject, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, `session-integration:${id}`, `${id}@example.test`, 'Session integration user'],
  );
  return id;
}

async function insertSession(input: {
  userId: string;
  tokenHash: Buffer;
  createdAt: Date;
  lastSeenAt?: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO app_sessions(user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.userId, input.tokenHash, input.createdAt, input.lastSeenAt ?? input.createdAt, input.idleExpiresAt, input.absoluteExpiresAt],
  );
}

test('Prisma session repository persists only a digest and derives lifetime from database time', async () => {
  const userId = await createUser();
  try {
    const issued = await sessionService.issue(userId);
    const result = await pool.query(
      `SELECT token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
              clock_timestamp() AS database_now
       FROM app_sessions WHERE id = $1`,
      [issued.sessionId],
    );
    const row = result.rows[0] as {
      token_hash: Buffer;
      created_at: Date;
      last_seen_at: Date;
      idle_expires_at: Date;
      absolute_expires_at: Date;
      database_now: Date;
    } | undefined;
    assert.ok(row);
    assert.deepEqual(row.token_hash, createHash('sha256').update(issued.token, 'ascii').digest());
    assert.equal(row.token_hash.byteLength, 32);
    assert.notDeepEqual(row.token_hash, Buffer.from(issued.token, 'ascii'));
    assert.ok(row.created_at <= row.database_now);
    assert.equal(row.last_seen_at.getTime(), row.created_at.getTime());
    assert.equal(row.idle_expires_at.getTime() - row.created_at.getTime(), sessionPolicy.idleTimeoutMs);
    assert.equal(row.absolute_expires_at.getTime() - row.created_at.getTime(), sessionPolicy.absoluteTimeoutMs);
    assert.ok(await sessionService.authenticate(issued.token));
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('database time expiry boundaries and disabled users fail authentication', async () => {
  const userId = await createUser();
  try {
    const idleSession = await sessionService.issue(userId);
    assert.ok(await sessionService.authenticate(idleSession.token));
    await pool.query(
      'UPDATE app_sessions SET idle_expires_at = clock_timestamp() WHERE id = $1',
      [idleSession.sessionId],
    );
    assert.equal(await sessionService.authenticate(idleSession.token), null, 'idle expiry at DB now is expired');

    const absoluteSession = await sessionService.issue(userId);
    await pool.query(
      `WITH operation_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
       UPDATE app_sessions AS s
       SET idle_expires_at = t.now, absolute_expires_at = t.now
       FROM operation_time AS t
       WHERE s.id = $1`,
      [absoluteSession.sessionId],
    );
    const expiredAbsolute = await pool.query(
      `SELECT idle_expires_at <= clock_timestamp() AS idle_is_expired,
              absolute_expires_at <= clock_timestamp() AS absolute_is_expired
       FROM app_sessions WHERE id = $1`,
      [absoluteSession.sessionId],
    );
    assert.equal(expiredAbsolute.rows[0]?.idle_is_expired, true);
    assert.equal(expiredAbsolute.rows[0]?.absolute_is_expired, true);
    assert.equal(await sessionService.authenticate(absoluteSession.token), null, 'absolute expiry at DB now is expired');

    const disabledSession = await sessionService.issue(userId);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
    assert.equal(await sessionService.authenticate(disabledSession.token), null);
    await assert.rejects(() => sessionService.issue(userId), /inactive or missing user/);
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('idle refresh uses the DB clock and never extends beyond absolute expiry', async () => {
  const userId = await createUser();
  try {
    const issued = await sessionService.issue(userId);
    await pool.query(
      `WITH operation_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
       UPDATE app_sessions AS s
       SET created_at = t.now - INTERVAL '1 minute',
           last_seen_at = t.now - INTERVAL '20 seconds',
           idle_expires_at = t.now + INTERVAL '15 seconds',
           absolute_expires_at = t.now + INTERVAL '30 seconds'
       FROM operation_time AS t
       WHERE s.id = $1`,
      [issued.sessionId],
    );
    assert.ok(await sessionService.authenticate(issued.token));
    const refreshed = await pool.query(
      `SELECT idle_expires_at, absolute_expires_at, last_seen_at
       FROM app_sessions WHERE id = $1`,
      [issued.sessionId],
    );
    const row = refreshed.rows[0] as { idle_expires_at: Date; absolute_expires_at: Date; last_seen_at: Date };
    assert.equal(row.idle_expires_at.getTime(), row.absolute_expires_at.getTime());
    assert.ok(row.last_seen_at > new Date('2000-01-01T00:00:00.000Z'));
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('revoked and replayed bearer tokens stay unusable and revoke is idempotent', async () => {
  const userId = await createUser();
  try {
    const issued = await sessionService.issue(userId);
    assert.ok(await sessionService.authenticate(issued.token));
    await sessionService.revoke(issued.token);
    const firstRevocation = await pool.query('SELECT revoked_at FROM app_sessions WHERE id = $1', [issued.sessionId]);
    assert.ok(firstRevocation.rows[0]?.revoked_at);

    await sessionService.revoke(issued.token);
    const secondRevocation = await pool.query('SELECT revoked_at FROM app_sessions WHERE id = $1', [issued.sessionId]);
    assert.equal(secondRevocation.rows[0]?.revoked_at?.getTime(), firstRevocation.rows[0]?.revoked_at?.getTime());
    assert.equal(await sessionService.authenticate(issued.token), null);
    const unknownToken = createHash('sha256').update(randomUUID()).digest('base64url');
    assert.equal(await sessionService.authenticate(unknownToken), null);
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('concurrent lookups and logout leave the next request denied', async () => {
  const userId = await createUser();
  try {
    const issued = await sessionService.issue(userId);
    const concurrent = await Promise.all([
      sessionService.authenticate(issued.token),
      sessionService.authenticate(issued.token),
      sessionService.authenticate(issued.token),
      sessionService.revoke(issued.token),
    ]);
    for (const outcome of concurrent.slice(0, 3)) {
      assert.ok(outcome === null || (typeof outcome === 'object'
        && outcome.userId === userId && outcome.sessionId === issued.sessionId));
    }
    assert.equal(await sessionService.authenticate(issued.token), null);
    const persisted = await pool.query('SELECT revoked_at FROM app_sessions WHERE id = $1', [issued.sessionId]);
    assert.ok(persisted.rows[0]?.revoked_at);
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('database constraints enforce hash size, uniqueness, lifecycle and user foreign key', async () => {
  const userId = await createUser();
  try {
    const nowResult = await pool.query('SELECT clock_timestamp() AS now');
    const now = nowResult.rows[0]?.now as Date;
    const idle = new Date(now.getTime() + sessionPolicy.idleTimeoutMs);
    const absolute = new Date(now.getTime() + sessionPolicy.absoluteTimeoutMs);
    const uniqueHash = Buffer.alloc(32, 17);
    await insertSession({ userId, tokenHash: uniqueHash, createdAt: now, idleExpiresAt: idle, absoluteExpiresAt: absolute });

    await insertSession({ userId, tokenHash: Buffer.alloc(31, 18), createdAt: now, idleExpiresAt: idle, absoluteExpiresAt: absolute }).then(
      () => assert.fail('short token digest unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23514'),
    );
    await insertSession({ userId, tokenHash: uniqueHash, createdAt: now, idleExpiresAt: idle, absoluteExpiresAt: absolute }).then(
      () => assert.fail('duplicate token digest unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23505'),
    );
    await insertSession({
      userId,
      tokenHash: Buffer.alloc(32, 19),
      createdAt: now,
      idleExpiresAt: absolute,
      absoluteExpiresAt: idle,
    }).then(
      () => assert.fail('invalid session lifecycle unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23514'),
    );
    await insertSession({
      userId: randomUUID(),
      tokenHash: Buffer.alloc(32, 20),
      createdAt: now,
      idleExpiresAt: idle,
      absoluteExpiresAt: absolute,
    }).then(
      () => assert.fail('session for a missing user unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23503'),
    );
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test.after(async () => { await prisma.$disconnect(); await pool.end(); });
