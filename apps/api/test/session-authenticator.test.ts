import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import test from 'node:test';
import { SessionAuthenticator } from '../src/auth/session-authenticator.js';
import type {
  AuthenticateSessionRecord,
  CreateSessionRecord,
  CreatedSession,
  SessionRepository,
} from '../src/sessions/session-repository.js';
import { SessionService } from '../src/sessions/session-service.js';

const policy = { idleTimeoutMs: 60_000, absoluteTimeoutMs: 300_000, touchIntervalMs: 10_000 };
const token = Buffer.alloc(32, 7).toString('base64url');

class FakeSessionRepository implements SessionRepository {
  authenticateCalls = 0;
  lastAuthenticateRecord: AuthenticateSessionRecord | undefined;
  authenticateError: Error | undefined;
  result: { userId: string; sessionId: string } | null = { userId: 'db-user', sessionId: 'db-session' };

  async create(_record: CreateSessionRecord): Promise<CreatedSession> {
    throw new Error('create is not used by authenticator tests');
  }

  async authenticate(record: AuthenticateSessionRecord): Promise<{ userId: string; sessionId: string } | null> {
    this.authenticateCalls++;
    this.lastAuthenticateRecord = record;
    if (this.authenticateError) throw this.authenticateError;
    return this.result;
  }

  async revoke(_tokenHash: Buffer): Promise<void> {}
}

function request(fields: Record<string, unknown>): Request {
  return fields as unknown as Request;
}

test('configured session authenticator reads only the named parsed cookie', async () => {
  const repository = new FakeSessionRepository();
  const sessions = new SessionService(repository, policy);
  const authenticator = new SessionAuthenticator(sessions, { providerAuthenticationComplete: true });
  const result = await authenticator.authenticate(request({
    cookies: { app_session: token, other_cookie: 'wrong-cookie' },
    headers: { authorization: `Bearer ${token}`, 'x-user-id': 'header-user' },
    body: { userId: 'body-user', sessionId: 'body-session' },
  }), 'app_session');

  assert.equal(authenticator.configured, true);
  assert.deepEqual(result, { userId: 'db-user', sessionId: 'db-session' });
  assert.equal(repository.authenticateCalls, 1);
  assert.deepEqual(repository.lastAuthenticateRecord?.tokenHash,
    createHash('sha256').update(token, 'ascii').digest());
});

test('absence, non-string and malformed cookies fail closed', async () => {
  const repository = new FakeSessionRepository();
  const authenticator = new SessionAuthenticator(new SessionService(repository, policy), {
    providerAuthenticationComplete: true,
  });

  assert.equal(await authenticator.authenticate(request({ cookies: {} }), 'app_session'), null);
  assert.equal(await authenticator.authenticate(request({ cookies: { app_session: 42 } }), 'app_session'), null);
  assert.equal(await authenticator.authenticate(request({ cookies: { app_session: 'not-a-session' } }), 'app_session'), null);
  assert.equal(repository.authenticateCalls, 0, 'SessionService rejects malformed values before storage lookup');
});

test('session persistence errors propagate to the HTTP error boundary', async () => {
  const repository = new FakeSessionRepository();
  const failure = new Error('storage unavailable');
  repository.authenticateError = failure;
  const authenticator = new SessionAuthenticator(new SessionService(repository, policy), {
    providerAuthenticationComplete: true,
  });

  await assert.rejects(
    () => authenticator.authenticate(request({ cookies: { app_session: token } }), 'app_session'),
    (error: unknown) => error === failure,
  );
});

test('a session store alone does not mark provider authentication configured or authenticate requests', async () => {
  const repository = new FakeSessionRepository();
  const authenticator = new SessionAuthenticator(new SessionService(repository, policy), {
    providerAuthenticationComplete: false,
  });

  assert.equal(authenticator.configured, false);
  assert.equal(await authenticator.authenticate(request({ cookies: { app_session: token } }), 'app_session'), null);
  assert.equal(repository.authenticateCalls, 0);
});
