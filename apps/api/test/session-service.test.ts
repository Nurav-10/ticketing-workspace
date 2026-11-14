import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type {
  AuthenticateSessionRecord,
  CreateSessionRecord,
  CreatedSession,
  SessionRepository,
} from '../src/sessions/session-repository.js';
import { SessionService } from '../src/sessions/session-service.js';

const policy = { idleTimeoutMs: 60_000, absoluteTimeoutMs: 300_000, touchIntervalMs: 10_000 };

class FakeSessionRepository implements SessionRepository {
  now = new Date('2026-01-01T00:00:00.000Z');
  createRecords: CreateSessionRecord[] = [];
  authenticateRecord: AuthenticateSessionRecord | undefined;
  revokedHash: Buffer | undefined;
  private session: (CreatedSession & {
    tokenHash: Buffer;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    revokedAt: Date | null;
    userActive: boolean;
    lastSeenAt: Date;
  }) | undefined;
  private nextId = 1;

  async create(record: CreateSessionRecord): Promise<CreatedSession> {
    this.createRecords.push(record);
    const createdAt = new Date(this.now);
    this.session = {
      id: `session-${this.nextId++}`,
      userId: record.userId,
      tokenHash: Buffer.from(record.tokenHash),
      idleExpiresAt: new Date(createdAt.getTime() + record.idleTimeoutMs),
      absoluteExpiresAt: new Date(createdAt.getTime() + record.absoluteTimeoutMs),
      revokedAt: null,
      userActive: true,
      lastSeenAt: createdAt,
    };
    return {
      id: this.session.id,
      userId: this.session.userId,
      idleExpiresAt: this.session.idleExpiresAt,
      absoluteExpiresAt: this.session.absoluteExpiresAt,
    };
  }

  async authenticate(record: AuthenticateSessionRecord): Promise<{ userId: string; sessionId: string } | null> {
    this.authenticateRecord = record;
    const session = this.session;
    const now = this.now.getTime();
    if (!session || !session.tokenHash.equals(record.tokenHash) || session.revokedAt
      || !session.userActive || session.idleExpiresAt.getTime() <= now
      || session.absoluteExpiresAt.getTime() <= now) return null;

    if (session.lastSeenAt.getTime() <= now - record.touchIntervalMs) {
      session.lastSeenAt = new Date(now);
      session.idleExpiresAt = new Date(Math.min(
        now + record.idleTimeoutMs,
        session.absoluteExpiresAt.getTime(),
      ));
    }
    return { userId: session.userId, sessionId: session.id };
  }

  async revoke(tokenHash: Buffer): Promise<void> {
    this.revokedHash = Buffer.from(tokenHash);
    if (this.session?.tokenHash.equals(tokenHash) && !this.session.revokedAt) {
      this.session.revokedAt = new Date(this.now);
    }
  }
}

test('issues a fresh 256-bit opaque bearer token and persists only its SHA-256 hash', async () => {
  const repository = new FakeSessionRepository();
  const service = new SessionService(repository, policy);
  const first = await service.issue('user-1');
  const second = await service.issue('user-1');

  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.token, 'base64url').length, 32);
  assert.notEqual(first.token, second.token);
  assert.equal(repository.createRecords.length, 2);
  assert.deepEqual(repository.createRecords[0]?.tokenHash, createHash('sha256').update(first.token, 'ascii').digest());
  assert.equal('token' in (repository.createRecords[0] ?? {}), false);
  assert.equal(first.idleExpiresAt.toISOString(), '2026-01-01T00:01:00.000Z');
  assert.equal(first.absoluteExpiresAt.toISOString(), '2026-01-01T00:05:00.000Z');
});

test('authenticates by token hash and delegates idle/absolute expiry and active-user checks atomically', async () => {
  const repository = new FakeSessionRepository();
  const service = new SessionService(repository, policy);
  const issued = await service.issue('user-1');

  assert.deepEqual(await service.authenticate(issued.token), { userId: 'user-1', sessionId: 'session-1' });
  assert.deepEqual(repository.authenticateRecord?.tokenHash,
    createHash('sha256').update(issued.token, 'ascii').digest());
  assert.equal(repository.authenticateRecord?.touchIntervalMs, policy.touchIntervalMs);

  repository.now = new Date('2026-01-01T00:01:00.000Z');
  assert.equal(await service.authenticate(issued.token), null, 'idle expiry is exclusive at its boundary');

  repository.now = new Date('2026-01-01T00:00:00.000Z');
  const active = await service.issue('user-2');
  repository.now = new Date('2026-01-01T00:05:00.000Z');
  assert.equal(await service.authenticate(active.token), null, 'absolute expiry is exclusive at its boundary');
});

test('revoke is idempotent and subsequent authentication fails', async () => {
  const repository = new FakeSessionRepository();
  const service = new SessionService(repository, policy);
  const issued = await service.issue('user-1');

  await service.revoke(issued.token);
  await service.revoke(issued.token);
  assert.deepEqual(repository.revokedHash, createHash('sha256').update(issued.token, 'ascii').digest());
  assert.equal(await service.authenticate(issued.token), null);
});

test('malformed and non-canonical tokens fail closed without repository access', async () => {
  const repository = new FakeSessionRepository();
  const service = new SessionService(repository, policy);

  assert.equal(await service.authenticate(null), null);
  assert.equal(await service.authenticate('not-a-token'), null);
  assert.equal(await service.authenticate(`${'A'.repeat(42)}!`), null);
  await service.revoke('not-a-token');
  assert.equal(repository.authenticateRecord, undefined);
  assert.equal(repository.revokedHash, undefined);
});

test('rejects unsafe session lifetime configuration', () => {
  const repository = new FakeSessionRepository();
  assert.throws(() => new SessionService(repository, { ...policy, idleTimeoutMs: 400_000 }));
  assert.throws(() => new SessionService(repository, { ...policy, touchIntervalMs: 0 }));
  assert.throws(() => new SessionService(repository, { ...policy, touchIntervalMs: policy.idleTimeoutMs }));
});
