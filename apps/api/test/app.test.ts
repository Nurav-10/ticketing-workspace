import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { UnconfiguredAuthenticator, assertProductionAuthenticator } from '../src/auth/authenticator.js';
import { ApiError } from '../src/shared/api-error.js';

function dependencies(readinessQuery: () => Promise<unknown> = async () => undefined) {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test', PUBLIC_ORIGIN: 'https://trusted.example' });
  const authenticator = {
    configured: true,
    authenticate: async (_request: unknown, cookieName: string) => {
      assert.equal(cookieName, 'app_session');
      return { userId: 'user-1', sessionId: 'session-1' };
    }
  };
  const workspaceService = { listForPrincipal: async (principal: { userId: string }) => [{ id: 'workspace-1', name: 'Product', slug: 'product', role: 'member' as const }].filter(() => principal.userId === 'user-1') };
  const invitationService = { redeem: async (_principal: unknown, token: string) => {
    if (token === 'valid-' + 'x'.repeat(40)) return { workspaceId: 'workspace-1', role: 'member' as const };
    throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
  } };
  const appPromise = buildApp({ config, authenticator, readinessProbe: { query: readinessQuery }, workspaceService, invitationService });
  return { config, authenticator, appPromise };
}

test('health remains available and readiness reports dependency failure', async () => {
  const { appPromise } = dependencies(async () => { throw new Error('database down'); });
  const app = await appPromise;
  try {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    assert.ok(health.headers['x-request-id']);
    const readiness = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(readiness.statusCode, 503);
    assert.equal(readiness.json().error.code, 'not_ready');
  } finally { await app.close(); }
});

test('health probes do not depend on the identity provider', async () => {
  const { config } = dependencies();
  let authenticationAttempts = 0;
  const app = await buildApp({
    config,
    authenticator: { configured: true, authenticate: async () => { authenticationAttempts++; throw new Error('identity provider unavailable'); } },
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService: { redeem: async () => ({ workspaceId: 'w', role: 'member' as const }) }
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 200);
    assert.equal(authenticationAttempts, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/workspaces' })).statusCode, 500);
    assert.equal(authenticationAttempts, 1);
  } finally { await app.close(); }
});

test('workspace route requires an authenticated principal', async () => {
  const { config } = dependencies();
  const app = await buildApp({
    config,
    authenticator: new UnconfiguredAuthenticator(),
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService: { redeem: async () => ({ workspaceId: 'w', role: 'member' as const }) }
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspaces' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'unauthenticated');
  } finally { await app.close(); }
});

test('workspace service receives the verified principal and returns its scoped records', async () => {
  const { appPromise } = dependencies();
  const app = await appPromise;
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspaces' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, [{ id: 'workspace-1', name: 'Product', slug: 'product', role: 'member' }]);
  } finally { await app.close(); }
});

test('authenticated unsafe requests accept only explicit configured origin despite Host and forwarded-header spoofing', async () => {
  const { appPromise } = dependencies();
  const app = await appPromise;
  try {
    const accepted = await app.inject({
      method: 'POST', url: '/api/v1/invitations/redeem',
      headers: { origin: 'https://trusted.example', host: 'attacker.invalid', 'x-forwarded-host': 'attacker.invalid' },
      payload: { token: 'valid-' + 'x'.repeat(40) }
    });
    assert.equal(accepted.statusCode, 200);

    const rejected = await app.inject({
      method: 'POST', url: '/api/v1/invitations/redeem',
      headers: { origin: 'https://attacker.invalid', host: 'trusted.example', 'x-forwarded-host': 'trusted.example' },
      payload: { token: 'valid-' + 'x'.repeat(40) }
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.json().error.code, 'origin_rejected');

    const missing = await app.inject({
      method: 'POST', url: '/api/v1/invitations/redeem',
      headers: { host: 'trusted.example' },
      payload: { token: 'valid-' + 'x'.repeat(40) }
    });
    assert.equal(missing.statusCode, 403);
  } finally { await app.close(); }
});

test('production rejects the unconfigured authenticator and unrestricted proxy trust', () => {
  assert.throws(() => assertProductionAuthenticator('production', new UnconfiguredAuthenticator()), /requires a configured identity provider/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/db', PUBLIC_ORIGIN: 'https://trusted.example', TRUST_PROXY: 'true' }), /bounded trusted-proxy policy/);
});
