import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaRateLimitRepository } from '../src/rate-limit/prisma-rate-limit-repository.js';
import { RateLimiter } from '../src/rate-limit/rate-limiter.js';
import { pool, prisma } from './test-database.js';

const hmacSecret = randomBytes(32);

test('parallel requests across connections share one atomic database counter', async () => {
  const repository = new PrismaRateLimitRepository(prisma);
  const limiter = new RateLimiter(repository, {
    hmacSecret,
    policies: { 'integration.concurrent': { limit: 5, windowMs: 60_000, retentionMs: 120_000 } },
  });
  const identifier = `parallel-${randomUUID()}`;
  const decisions = await Promise.all(Array.from({ length: 32 }, () => limiter.consume('integration.concurrent', identifier)));

  assert.equal(decisions.filter((decision) => decision.allowed).length, 5);
  assert.equal(decisions.filter((decision) => !decision.allowed && decision.reason === 'limit').length, 27);
  const identifierHash = createHmac('sha256', hmacSecret)
    .update('integration.concurrent\0')
    .update(identifier)
    .digest();
  const rows = await pool.query(
    `SELECT identifier_hash, hit_count::text AS hit_count, window_start, expires_at
     FROM rate_limit_counters WHERE operation = $1 AND identifier_hash = $2`,
    ['integration.concurrent', identifierHash],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0]?.hit_count, '32');
  assert.equal(Buffer.from(rows.rows[0]?.identifier_hash ?? []).includes(Buffer.from(identifier)), false);
});

test('fixed window boundaries and retry delay use the PostgreSQL clock', async () => {
  const repository = new PrismaRateLimitRepository(prisma);
  const identifier = `database-time-${randomUUID()}`;
  const identifierHash = createHmac('sha256', hmacSecret)
    .update('integration.clock\0')
    .update(identifier)
    .digest();
  const observation = await repository.increment({
    operation: 'integration.clock',
    identifierHash,
    windowMs: 1_000,
    retentionMs: 10_000,
  });

  assert.ok(observation.databaseNow >= new Date(observation.windowEndsAt.getTime() - 1_000));
  assert.ok(observation.databaseNow < observation.windowEndsAt);
  assert.equal(observation.windowEndsAt.getTime() % 1_000, 0);
});

test('cleanup deletes counters only after database expiry', async () => {
  const repository = new PrismaRateLimitRepository(prisma);
  const identifier = `cleanup-${randomUUID()}`;
  const identifierHash = createHmac('sha256', hmacSecret)
    .update('integration.cleanup\0')
    .update(identifier)
    .digest();
  await repository.increment({
    operation: 'integration.cleanup',
    identifierHash,
    windowMs: 1_000,
    retentionMs: 10_000,
  });

  await pool.query(
    `UPDATE rate_limit_counters
     SET window_start = clock_timestamp() - interval '2 seconds',
         expires_at = clock_timestamp() - interval '1 second'
     WHERE operation = $1 AND identifier_hash = $2`,
    ['integration.cleanup', identifierHash],
  );
  // Other tests and prior runs can leave expired buckets in this disposable DB.
  // Verify this bucket's removal instead of assuming global cleanup sees only one.
  assert.ok(await repository.deleteExpired(5_000) >= 1);
  const rows = await pool.query(
    'SELECT 1 FROM rate_limit_counters WHERE operation = $1 AND identifier_hash = $2',
    ['integration.cleanup', identifierHash],
  );
  assert.equal(rows.rowCount, 0);
});

test.after(async () => { await prisma.$disconnect(); await pool.end(); });
