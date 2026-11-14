import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import type {
  IncrementRateLimitBucket,
  RateLimitBucketObservation,
  RateLimitRepository,
} from '../src/rate-limit/rate-limit-repository.js';
import { RateLimiter, type RateLimitPolicy } from '../src/rate-limit/rate-limiter.js';
import { resolveClientAddress } from '../src/rate-limit/client-address.js';

const secret = randomBytes(32);
const policy: RateLimitPolicy = { limit: 2, windowMs: 60_000, retentionMs: 120_000 };

class FakeRateLimitRepository implements RateLimitRepository {
  calls: IncrementRateLimitBucket[] = [];
  observations: RateLimitBucketObservation[] = [];
  failure: unknown;
  deleted = 0;
  cleanupBatchSize = 0;

  async increment(input: IncrementRateLimitBucket): Promise<RateLimitBucketObservation> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return this.observations.shift() ?? {
      hitCount: 1n,
      windowStartsAt: new Date('2026-11-14T10:00:00.000Z'),
      windowEndsAt: new Date('2026-11-14T10:01:00.000Z'),
      databaseNow: new Date('2026-11-14T10:00:00.000Z'),
    };
  }

  async deleteExpired(batchSize: number): Promise<number> {
    this.cleanupBatchSize = batchSize;
    return this.deleted;
  }
}

test('requires an independent 32-byte HMAC key and bounded explicit operation policies', () => {
  const repository = new FakeRateLimitRepository();
  assert.throws(() => new RateLimiter(repository, undefined as never), /HMAC secret/);
  assert.throws(() => new RateLimiter(repository, { hmacSecret: Buffer.alloc(31), policies: { login: policy } }), /HMAC secret/);
  assert.throws(() => new RateLimiter(repository, { hmacSecret: secret, policies: {} }), /At least one/);
  assert.throws(() => new RateLimiter(repository, {
    hmacSecret: secret, policies: { login: { ...policy, windowMs: 0 } },
  }), /window/);
  assert.throws(() => new RateLimiter(repository, {
    hmacSecret: secret, policies: { login: { ...policy, retentionMs: policy.windowMs - 1 } },
  }), /retention/);
  assert.throws(() => new RateLimiter(repository, {
    hmacSecret: secret, policies: { 'Bad Operation': policy },
  }), /operation name/);
});

test('HMACs the identifier with operation domain separation and returns the limit decision', async () => {
  const repository = new FakeRateLimitRepository();
  repository.observations.push({
    hitCount: 1n,
    windowStartsAt: new Date('2026-11-14T10:00:00.000Z'),
    windowEndsAt: new Date('2026-11-14T10:01:00.000Z'),
    databaseNow: new Date('2026-11-14T10:00:30.000Z'),
  });
  const limiter = new RateLimiter(repository, { hmacSecret: secret, policies: { 'login.ip': policy } });
  const identifier = '203.0.113.9';

  assert.deepEqual(await limiter.consume('login.ip', identifier), {
    allowed: true, limit: 2, remaining: 1, retryAfterMs: 0,
  });
  assert.equal(repository.calls[0]?.operation, 'login.ip');
  assert.deepEqual(repository.calls[0]?.identifierHash,
    createHmac('sha256', secret).update('login.ip\0').update(identifier).digest());
  assert.equal(repository.calls[0]?.identifierHash.includes(Buffer.from(identifier)), false);
  assert.equal(repository.calls[0]?.windowMs, policy.windowMs);
  assert.equal(repository.calls[0]?.retentionMs, policy.retentionMs);
});

test('blocks when count exceeds the configured limit and uses database window time', async () => {
  const repository = new FakeRateLimitRepository();
  repository.observations.push({
    hitCount: 3n,
    windowStartsAt: new Date('2026-11-14T10:00:00.000Z'),
    windowEndsAt: new Date('2026-11-14T10:01:00.000Z'),
    databaseNow: new Date('2026-11-14T10:00:42.250Z'),
  });
  const limiter = new RateLimiter(repository, { hmacSecret: secret, policies: { login: policy } });

  assert.deepEqual(await limiter.consume('login', 'account-key'), {
    allowed: false, limit: 2, remaining: 0, retryAfterMs: 17_750, reason: 'limit',
  });
});

test('fails closed if repository returns a bucket that is no longer current', async () => {
  const repository = new FakeRateLimitRepository();
  repository.observations.push({
    hitCount: 1n,
    windowStartsAt: new Date('2026-11-14T10:00:00.000Z'),
    windowEndsAt: new Date('2026-11-14T10:01:00.000Z'),
    databaseNow: new Date('2026-11-14T10:01:00.000Z'),
  });
  const limiter = new RateLimiter(repository, { hmacSecret: secret, policies: { login: policy } });

  assert.deepEqual(await limiter.consume('login', 'boundary-key'), {
    allowed: false, limit: 2, remaining: 0, retryAfterMs: 60_000, reason: 'storage',
  });
});

test('fails closed on storage errors and malformed operations or identifiers', async () => {
  const repository = new FakeRateLimitRepository();
  const limiter = new RateLimiter(repository, { hmacSecret: secret, policies: { login: policy } });
  repository.failure = new Error('database unavailable');

  assert.deepEqual(await limiter.consume('login', 'some-account'), {
    allowed: false, limit: 2, remaining: 0, retryAfterMs: 60_000, reason: 'storage',
  });
  assert.deepEqual(await limiter.consume('unknown', 'some-account'), {
    allowed: false, limit: 0, remaining: 0, retryAfterMs: 1_000, reason: 'invalid',
  });
  assert.deepEqual(await limiter.consume('login', '  '), {
    allowed: false, limit: 2, remaining: 0, retryAfterMs: 60_000, reason: 'invalid',
  });
  assert.equal(repository.calls.length, 1);
});

test('delegates expired-row cleanup to the repository', async () => {
  const repository = new FakeRateLimitRepository();
  repository.deleted = 7;
  const limiter = new RateLimiter(repository, { hmacSecret: secret, policies: { login: policy } });
  assert.equal(await limiter.deleteExpired(100), 7);
  assert.equal(repository.cleanupBatchSize, 100);
  assert.throws(() => limiter.deleteExpired(5_001), /batch size/);
});

test('ignores X-Forwarded-For when proxy trust is disabled', () => {
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '198.51.100.22',
    forwardedFor: '203.0.113.5',
    policy: { trustProxy: false },
  }), '198.51.100.22');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: 'not-an-ip',
    forwardedFor: '203.0.113.5',
    policy: { trustProxy: false },
  }), null);
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '2001:0DB8:0:0:0:0:0:1',
    forwardedFor: null,
    policy: { trustProxy: false },
  }), '2001:db8::1');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '::ffff:203.0.113.9',
    forwardedFor: null,
    policy: { trustProxy: false },
  }), '203.0.113.9');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '2001:0DB8:0:0:0:0:0:1',
    forwardedFor: null,
    policy: { trustProxy: false },
  }), '2001:db8::1');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '::ffff:203.0.113.9',
    forwardedFor: null,
    policy: { trustProxy: false },
  }), '203.0.113.9');
});

test('uses forwarded client only through an allowlisted bounded proxy chain', () => {
  const policy = {
    trustProxy: true as const,
    trustedProxyAddresses: ['10.10.0.4', '10.10.0.5'],
    maxForwardedHops: 3,
  };
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '10.10.0.5',
    forwardedFor: '203.0.113.7, 10.10.0.4',
    policy,
  }), '203.0.113.7');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '198.51.100.22',
    forwardedFor: '203.0.113.7',
    policy,
  }), '198.51.100.22');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '10.10.0.5',
    forwardedFor: '203.0.113.7, invalid',
    policy,
  }), '10.10.0.5');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '10.10.0.5',
    forwardedFor: '1'.repeat(1_025),
    policy,
  }), '10.10.0.5');
  assert.equal(resolveClientAddress({
    socketRemoteAddress: '10.10.0.5',
    forwardedFor: `${'1'.repeat(1_025)}`,
    policy,
  }), '10.10.0.5');
  assert.throws(() => resolveClientAddress({
    socketRemoteAddress: '10.10.0.5',
    forwardedFor: '203.0.113.7',
    policy: { trustProxy: true, trustedProxyAddresses: [], maxForwardedHops: 1 },
  }), /allowlist/);
});
