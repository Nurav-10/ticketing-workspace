import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Router } from 'express';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { UnconfiguredAuthenticator, assertProductionAuthenticator } from '../src/auth/authenticator.js';
import { ApiError } from '../src/shared/api-error.js';
import type { IssuedInvitationRecord } from '../src/invitations/invitation-repository.js';
import type { IssueService } from '../src/issues/issue-service.js';
import type { IssueSummary } from '../src/issues/issue-domain.js';

function dependencies(readinessQuery: () => Promise<unknown> = async () => undefined, authRoutes?: { mountPath: string; router: Router }, issueService?: IssueService) {
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
  }, issue: async (): Promise<IssuedInvitationRecord & { token: string }> => { throw new Error('Invitation issue is not exercised in this app fixture'); }, listPending: async () => [], revoke: async () => undefined };
  const teamService = { listVisibleToPrincipal: async () => [], createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, listPrivateMembersForPrincipal: async () => ({ data: [], hasMore: false, nextCursor: null }), listPrivateTeamsForPrincipal: async () => ({ data: [], hasMore: false, nextCursor: null }) };
  const membershipService = { changeRoleForPrincipal: async () => undefined, removeMemberForPrincipal: async () => undefined, transferOwnershipForPrincipal: async () => undefined, leaveWorkspaceForPrincipal: async () => undefined };
  const app = buildApp({ config, authenticator, readinessProbe: { query: readinessQuery }, workspaceService, invitationService, teamService, membershipService, ...(authRoutes ? { authRoutes } : {}), ...(issueService ? { issueService } : {}) });
  return { config, authenticator, app };
}

test('configured authentication routes receive request IDs and parsed cookies at their mount path', async () => {
  const router = Router();
  router.get('/callback', (request, response) => {
    response.json({ requestId: request.id, cookie: request.cookies?.probe });
  });
  const { app } = dependencies(undefined, { mountPath: '/auth', router });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/auth/callback`, { headers: { cookie: 'probe=present' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { requestId: string; cookie: string };
    assert.equal(body.cookie, 'present');
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.ok(body.requestId);
    const status = await fetch(`${server.baseUrl}/api/v1/auth/status`);
    assert.deepEqual(await status.json(), { data: { available: true } });
    assert.equal(status.headers.get('cache-control'), 'no-store');
  } finally { await server.close(); }
});

test('auth status reports unavailable when sign-in is not configured', async () => {
  const { app } = dependencies();
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/auth/status`);
    assert.deepEqual(await response.json(), { data: { available: false } });
  } finally { await server.close(); }
});

async function listen(app: ReturnType<typeof buildApp>): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test('health remains available and readiness reports dependency failure over HTTP', async () => {
  const { app } = dependencies(async () => { throw new Error('database down'); });
  const server = await listen(app);
  try {
    const health = await fetch(`${server.baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.ok(health.headers.get('x-request-id'));
    const readiness = await fetch(`${server.baseUrl}/api/v1/ready`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json() as { error: { code: string } }).error.code, 'not_ready');
  } finally { await server.close(); }
});

test('health probes do not depend on the identity provider', async () => {
  const { config } = dependencies();
  let authenticationAttempts = 0;
  const app = buildApp({
    config,
    authenticator: { configured: true, authenticate: async () => { authenticationAttempts++; throw new Error('identity provider unavailable'); } },
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService: { redeem: async () => ({ workspaceId: 'w', role: 'member' as const }), issue: async (): Promise<IssuedInvitationRecord & { token: string }> => { throw new Error('not exercised'); }, listPending: async () => [], revoke: async () => undefined },
    teamService: { listVisibleToPrincipal: async () => [], createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, listPrivateMembersForPrincipal: async () => ({ data: [], hasMore: false, nextCursor: null }), listPrivateTeamsForPrincipal: async () => ({ data: [], hasMore: false, nextCursor: null }) },
    membershipService: { changeRoleForPrincipal: async () => undefined, removeMemberForPrincipal: async () => undefined, transferOwnershipForPrincipal: async () => undefined, leaveWorkspaceForPrincipal: async () => undefined }
  });
  const server = await listen(app);
  try {
    assert.equal((await fetch(`${server.baseUrl}/api/v1/health`)).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/api/v1/ready`)).status, 200);
    assert.equal(authenticationAttempts, 0);
    assert.equal((await fetch(`${server.baseUrl}/api/v1/workspaces`)).status, 500);
    assert.equal(authenticationAttempts, 1);
  } finally { await server.close(); }
});

test('workspace route requires an authenticated principal', async () => {
  const { config } = dependencies();
  const app = buildApp({
    config,
    authenticator: new UnconfiguredAuthenticator(),
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService: { redeem: async () => ({ workspaceId: 'w', role: 'member' as const }), issue: async (): Promise<IssuedInvitationRecord & { token: string }> => { throw new Error('not exercised'); }, listPending: async () => [], revoke: async () => undefined },
    teamService: { listVisibleToPrincipal: async () => [], createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, listPrivateMembersForPrincipal: async () => ({ data: [], hasMore: false, nextCursor: null }), listPrivateTeamsForPrincipal: async () => ({ data: [], hasMore: false, nextCursor: null }) },
    membershipService: { changeRoleForPrincipal: async () => undefined, removeMemberForPrincipal: async () => undefined, transferOwnershipForPrincipal: async () => undefined, leaveWorkspaceForPrincipal: async () => undefined }
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unauthenticated');
  } finally { await server.close(); }
});

test('workspace service receives the verified principal and returns its scoped records', async () => {
  const { app } = dependencies();
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json() as { data: unknown }).data, [{ id: 'workspace-1', name: 'Product', slug: 'product', role: 'member' }]);
  } finally { await server.close(); }
});

test('issue creation accepts a maximum-length description with JSON-escaped control characters', async () => {
  const description = '\u0001'.repeat(20_000);
  let receivedDescription: string | null | undefined;
  const issue: IssueSummary = {
    id: '24fba2dd-8131-4c53-a8b4-07ab988da002', workspaceId: '8bb8e0ee-238c-4ba5-89ba-0f4e852861af',
    teamId: 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a', issueNumber: 1, key: 'ENG-1', title: 'Example',
    description, status: 'backlog', priority: 'none', assigneeUserId: null, assignee: null,
    createdByUserId: 'user-1', version: 1, createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'), archivedAt: null,
  };
  const issueService = {
    createForPrincipal: async (_principal: unknown, input: { description?: string | null }) => {
      receivedDescription = input.description;
      return issue;
    },
  } as unknown as IssueService;
  const { app } = dependencies(undefined, undefined, issueService);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${issue.workspaceId}/teams/${issue.teamId}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://trusted.example', 'idempotency-key': 'description-limit-test' },
      body: JSON.stringify({ title: 'Example', description }),
    });
    assert.equal(response.status, 201);
    assert.equal(receivedDescription, description);
    assert.equal((await response.json() as { data: { description: string } }).data.description, description);
  } finally { await server.close(); }
});

test('issue requests exceeding the 128kb JSON limit return the standard too-large error', async () => {
  let serviceCalled = false;
  const issueService = {
    createForPrincipal: async () => { serviceCalled = true; throw new Error('must not reach the issue service'); },
  } as unknown as IssueService;
  const { app } = dependencies(undefined, undefined, issueService);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/8bb8e0ee-238c-4ba5-89ba-0f4e852861af/teams/f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://trusted.example', 'idempotency-key': 'oversized-description-test' },
      body: JSON.stringify({ title: 'Example', description: '\u0001'.repeat(22_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'request_too_large');
    assert.equal(serviceCalled, false);
  } finally { await server.close(); }
});

test('non-issue JSON requests retain the 32kb body limit', async () => {
  const { app } = dependencies();
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/invitations/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://trusted.example' },
      body: JSON.stringify({ token: 'x'.repeat(40_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'request_too_large');
  } finally { await server.close(); }
});

test('authenticated unsafe requests accept only explicit configured origin despite Host and forwarded-header spoofing', async () => {
  const { app } = dependencies();
  const server = await listen(app);
  try {
    const accepted = await fetch(`${server.baseUrl}/api/v1/invitations/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://trusted.example', host: 'attacker.invalid', 'x-forwarded-host': 'attacker.invalid' },
      body: JSON.stringify({ token: 'valid-' + 'x'.repeat(40) })
    });
    assert.equal(accepted.status, 200);

    const rejected = await fetch(`${server.baseUrl}/api/v1/invitations/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid', host: 'trusted.example', 'x-forwarded-host': 'trusted.example' },
      body: JSON.stringify({ token: 'valid-' + 'x'.repeat(40) })
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'origin_rejected');

    const missing = await fetch(`${server.baseUrl}/api/v1/invitations/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'trusted.example' },
      body: JSON.stringify({ token: 'valid-' + 'x'.repeat(40) })
    });
    assert.equal(missing.status, 403);
  } finally { await server.close(); }
});

test('request IDs and validation failures keep the public error contract', async () => {
  const { app } = dependencies();
  const server = await listen(app);
  try {
    const invalid = await fetch(`${server.baseUrl}/api/v1/invitations/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://trusted.example', 'x-request-id': 'request.test-01' },
      body: JSON.stringify({ token: 'short' })
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('x-request-id'), 'request.test-01');
    assert.deepEqual(await invalid.json(), { error: { code: 'invalid_request', message: 'Request validation failed', requestId: 'request.test-01' } });

    const missing = await fetch(`${server.baseUrl}/not-a-route`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'not_found');
  } finally { await server.close(); }
});

test('production rejects the unconfigured authenticator and unrestricted proxy trust', () => {
  assert.throws(() => assertProductionAuthenticator('production', new UnconfiguredAuthenticator()), /requires a configured identity provider/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/db', PUBLIC_ORIGIN: 'https://trusted.example', TRUST_PROXY: 'true' }), /bounded trusted-proxy policy/);
});
