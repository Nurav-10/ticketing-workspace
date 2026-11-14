import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { AuthFlowError, AuthFlowService, type AuthFlowOidcProvider, type CompletedOidcLogin } from '../src/auth-flow/auth-flow-service.js';
import { registerAuthRoutes } from '../src/auth-flow/auth-routes.js';
import { deriveBootstrapGrantHash } from '../src/bootstrap/bootstrap-service.js';

const invitationToken = Buffer.alloc(32, 7).toString('base64url');
const invitationTokenHash = createHash('sha256').update(invitationToken, 'ascii').digest('base64url');
const verifiedIdentity = {
  issuer: 'https://issuer.example',
  subject: 'subject-1',
  email: 'person@example.com',
  emailVerified: true as const,
  displayName: 'Person',
};
const issuedSession = {
  token: 'session-secret',
  sessionId: 'session-1',
  idleExpiresAt: new Date(Date.now() + 60_000),
  absoluteExpiresAt: new Date(Date.now() + 120_000),
};

function fixture(options: {
  identity?: { kind: 'resolved'; userId: string } | { kind: 'provisioning_required' };
  invitationHash?: string;
  bootstrapHash?: string;
  providerConfigured?: boolean;
  failRevoke?: boolean;
} = {}) {
  const calls: { beginContexts: unknown[]; resolve: unknown[]; provision: unknown[]; redeem: unknown[]; bootstrap: unknown[]; issued: string[]; revoked: string[] } = {
    beginContexts: [], resolve: [], provision: [], redeem: [], bootstrap: [], issued: [], revoked: [],
  };
  const completed: CompletedOidcLogin = {
    identity: verifiedIdentity,
    ...(options.invitationHash === undefined ? {} : { invitationTokenHash: options.invitationHash }),
    ...(options.bootstrapHash === undefined ? {} : { bootstrapGrantHash: options.bootstrapHash }),
  };
  const provider: AuthFlowOidcProvider = {
    beginLogin: async (context) => {
      calls.beginContexts.push(context);
      return { transactionHandle: 'handle-secret', authorizationUrl: 'https://issuer.example/authorize?state=random' };
    },
    completeLogin: async () => completed,
  };
  const flow = new AuthFlowService(
    options.providerConfigured === false ? null : provider,
    {
      resolve: async (identity) => {
        calls.resolve.push(identity);
        return options.identity ?? { kind: 'resolved', userId: 'user-1' };
      },
      provisionFromInvitation: async (identity, grant) => {
        calls.provision.push({ identity, grant });
        return { kind: 'resolved', userId: 'new-user' };
      },
    },
    {
      issue: async (userId) => { calls.issued.push(userId); return issuedSession; },
      revoke: async (token) => { calls.revoked.push(token); if (options.failRevoke) throw new Error('database unavailable'); },
    },
    'https://app.example',
    { redeem: async (input) => { calls.redeem.push(input); return { workspaceId: 'workspace-1', role: 'member' }; } },
    {
      acceptsGrant: (hash) => hash.equals(deriveBootstrapGrantHash(Buffer.alloc(32, 9).toString('base64url'))!),
      bootstrap: async (input) => { calls.bootstrap.push(input); return { kind: 'created', userId: 'bootstrap-user', workspaceId: 'workspace-bootstrap' }; },
    },
  );
  return { flow, calls, provider };
}

test('login hashes invitation token before persisting context and resolves a fixed redirect', async () => {
  const { flow, calls } = fixture({ invitationHash: invitationTokenHash });
  const start = await flow.beginLogin(invitationToken);
  assert.equal(start.transactionHandle, 'handle-secret');
  assert.deepEqual(calls.beginContexts, [{ invitationTokenHash }]);
  assert.equal(JSON.stringify(calls.beginContexts).includes(invitationToken), false);
  const result = await flow.completeLogin(new URL('https://app.example/callback?code=secret'), 'handle-secret');
  assert.equal(result.redirectUrl, 'https://app.example/');
  assert.deepEqual(calls.redeem, [{ userId: 'user-1', tokenHash: Buffer.from(invitationTokenHash, 'base64url') }]);
  assert.deepEqual(calls.issued, ['user-1']);
});

test('new identities are provisioned only from the encrypted invitation digest', async () => {
  const { flow, calls } = fixture({ identity: { kind: 'provisioning_required' }, invitationHash: invitationTokenHash });
  await flow.completeLogin(new URL('https://app.example/callback?code=secret'), 'handle-secret');
  assert.equal(calls.provision.length, 1);
  assert.deepEqual(calls.provision[0], {
    identity: { issuer: verifiedIdentity.issuer, subject: verifiedIdentity.subject, email: verifiedIdentity.email, emailVerified: true, displayName: 'Person' },
    grant: { kind: 'invitation', tokenHash: Buffer.from(invitationTokenHash, 'base64url') },
  });
  assert.deepEqual(calls.issued, ['new-user']);
});

test('a raced identity creation still redeems the current invitation before issuing a session', async () => {
  const redeemed: unknown[] = [];
  let lookups = 0;
  const flow = new AuthFlowService(
    { beginLogin: async () => ({ transactionHandle: 'handle', authorizationUrl: 'https://issuer.example/' }),
      completeLogin: async () => ({ identity: verifiedIdentity, invitationTokenHash }) },
    { resolve: async () => ++lookups === 1 ? { kind: 'provisioning_required' } : { kind: 'resolved', userId: 'raced-user' },
      provisionFromInvitation: async () => ({ kind: 'retryable_conflict' }) },
    { issue: async () => issuedSession, revoke: async () => undefined },
    'https://app.example',
    { redeem: async (input) => { redeemed.push(input); return { workspaceId: 'workspace', role: 'member' }; } },
  );
  await flow.completeLogin(new URL('https://app.example/callback'), 'handle');
  assert.deepEqual(redeemed, [{ userId: 'raced-user', tokenHash: Buffer.from(invitationTokenHash, 'base64url') }]);
});

test('new identities without a valid explicit grant cannot receive sessions', async () => {
  const { flow, calls } = fixture({ identity: { kind: 'provisioning_required' } });
  await assert.rejects(flow.completeLogin(new URL('https://app.example/callback'), 'handle-secret'), AuthFlowError);
  assert.deepEqual(calls.issued, []);
});

test('resolved identities cannot silently ignore an invitation or redeem a malformed digest', async () => {
  const valid = fixture({ invitationHash: invitationTokenHash });
  await valid.flow.completeLogin(new URL('https://app.example/callback'), 'handle-secret');
  assert.equal(valid.calls.redeem.length, 1);

  const invalid = fixture({ invitationHash: 'not-a-canonical-digest' });
  await assert.rejects(invalid.flow.completeLogin(new URL('https://app.example/callback'), 'handle-secret'), AuthFlowError);
  assert.deepEqual(invalid.calls.issued, []);
  assert.deepEqual(invalid.calls.redeem, []);
});

test('bootstrap requires the internal configured seam, uses trusted workspace config, and rejects existing identities', async () => {
  const operatorSecret = Buffer.alloc(32, 9).toString('base64url');
  const grantHash = deriveBootstrapGrantHash(operatorSecret)!;
  const bootstrap = fixture({ identity: { kind: 'provisioning_required' }, bootstrapHash: grantHash.toString('base64url') });
  await bootstrap.flow.beginBootstrapLogin(operatorSecret);
  await assert.rejects(bootstrap.flow.beginBootstrapLogin(Buffer.alloc(32, 8).toString('base64url')), AuthFlowError);
  assert.deepEqual(bootstrap.calls.beginContexts, [{ bootstrapGrantHash: grantHash.toString('base64url') }]);
  await bootstrap.flow.completeLogin(new URL('https://app.example/callback'), 'handle-secret');
  assert.deepEqual(bootstrap.calls.bootstrap, [{
    identity: { issuer: verifiedIdentity.issuer, subject: verifiedIdentity.subject, email: verifiedIdentity.email, emailVerified: true, displayName: 'Person' },
    grantHash,
  }]);
  assert.deepEqual(bootstrap.calls.issued, ['bootstrap-user']);

  const existing = fixture({ bootstrapHash: grantHash.toString('base64url') });
  await assert.rejects(existing.flow.completeLogin(new URL('https://app.example/callback'), 'handle-secret'), AuthFlowError);
  assert.deepEqual(existing.calls.bootstrap, []);
  assert.deepEqual(existing.calls.issued, []);
});

test('missing OIDC configuration fails closed and invalid invitation tokens never start provider login', async () => {
  const { flow, calls } = fixture({ providerConfigured: false });
  await assert.rejects(flow.beginLogin(), AuthFlowError);
  assert.deepEqual(calls.beginContexts, []);
  const configured = fixture();
  await assert.rejects(configured.flow.beginLogin('bad-token'), AuthFlowError);
  assert.deepEqual(configured.calls.beginContexts, []);
});

async function listen(app: express.Express): Promise<{ url: string; close(): Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}

test('HTTP auth boundary limits origin, redirects, cookie attributes, and callback leakage', async () => {
  const { flow } = fixture();
  const app = express();
  app.use((req, res, next) => { req.id = 'req-auth-1'; res.setHeader('x-request-id', req.id); next(); });
  app.use(cookieParser());
  const router = express.Router();
  registerAuthRoutes(router, flow, {
    publicOrigin: 'https://app.example',
    callbackUri: 'https://app.example/api/v1/auth/callback',
    sessionCookieName: '__Host-app_session',
  });
  app.use('/api/v1/auth', router);
  const server = await listen(app);
  try {
    assert.equal((await fetch(`${server.url}/api/v1/auth/logout`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/v1/auth/login?next=https://evil.example`)).status, 400);
    const rejected = await fetch(`${server.url}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `invitationToken=${invitationToken}`,
    });
    assert.equal(rejected.status, 403);

    const start = await fetch(`${server.url}/api/v1/auth/login`, {
      method: 'POST', redirect: 'manual', headers: { origin: 'https://app.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `invitationToken=${invitationToken}`,
    });
    assert.equal(start.status, 303);
    assert.equal(start.headers.get('location')?.startsWith('https://issuer.example/'), true);
    assert.equal(start.headers.get('location')?.includes(invitationToken), false);
    assert.match(start.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(start.headers.get('set-cookie') ?? '', /Secure/);
    assert.match(start.headers.get('set-cookie') ?? '', /SameSite=Lax/);
    assert.match(start.headers.get('set-cookie') ?? '', /Path=\//);

    const callback = await fetch(`${server.url}/api/v1/auth/callback?code=secret-code&state=secret-state`, {
      redirect: 'manual', headers: { cookie: '__Host-oidc_login_tx=handle-secret' },
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), 'https://app.example/');
    const cookies = callback.headers.getSetCookie().join('\n');
    assert.match(cookies, /__Host-oidc_login_tx=.*(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/);
    assert.match(cookies, /__Host-app_session=session-secret/);
    assert.ok(cookies.includes(`Expires=${issuedSession.absoluteExpiresAt.toUTCString()}`));
    assert.doesNotMatch(callback.headers.get('location') ?? '', /code|state|secret/);

    const logout = await fetch(`${server.url}/api/v1/auth/logout`, {
      method: 'POST', headers: { origin: 'https://app.example', cookie: '__Host-app_session=session-secret' },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie') ?? '', /__Host-app_session=.*(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/);

    const wrongOriginLogout = await fetch(`${server.url}/api/v1/auth/logout`, {
      method: 'POST', headers: { origin: 'https://evil.example', cookie: '__Host-app_session=session-secret' },
    });
    assert.equal(wrongOriginLogout.status, 403);
  } finally { await server.close(); }
});

test('logout reports storage failure without clearing the cookie, so revocation can be retried', async () => {
  const { flow } = fixture({ failRevoke: true });
  const app = express();
  app.use((req, res, next) => { req.id = 'req-logout-1'; next(); });
  app.use(cookieParser());
  const router = express.Router();
  registerAuthRoutes(router, flow, {
    publicOrigin: 'https://app.example',
    callbackUri: 'https://app.example/api/v1/auth/callback',
    sessionCookieName: '__Host-app_session',
  });
  app.use('/api/v1/auth', router);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/v1/auth/logout`, {
      method: 'POST', headers: { origin: 'https://app.example', cookie: '__Host-app_session=session-secret' },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'logout_unavailable');
    assert.equal(response.headers.get('set-cookie'), null);
  } finally { await server.close(); }
});
