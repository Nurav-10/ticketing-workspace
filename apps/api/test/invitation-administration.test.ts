import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { UnconfiguredAuthenticator } from '../src/auth/authenticator.js';
import { loadConfig } from '../src/config/config.js';
import type { InvitationAdministrator } from '../src/invitations/invitation-service.js';
import type { Principal } from '../src/auth/authenticator.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const invitationId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const principal: Principal = { userId: '49a03ed2-7eb3-4c00-a8e1-519c70306427', sessionId: 'session-1' };

function appWith(service: InvitationAdministrator) {
  return buildApp({
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test', PUBLIC_ORIGIN: 'https://trusted.example' }),
    authenticator: { configured: true, authenticate: async () => principal },
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService: service,
    teamService: { listVisibleToPrincipal: async () => [], createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); } },
    membershipService: { changeRoleForPrincipal: async () => undefined, removeMemberForPrincipal: async () => undefined, transferOwnershipForPrincipal: async () => undefined, leaveWorkspaceForPrincipal: async () => undefined }
  });
}

async function listen(app: ReturnType<typeof buildApp>): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function fakeService(overrides: Partial<InvitationAdministrator> = {}): InvitationAdministrator {
  return {
    redeem: async () => ({ workspaceId, role: 'member' }),
    issue: async (_principal, requestedWorkspaceId, input) => ({
      id: invitationId,
      email: input.email,
      role: input.role,
      expiresAt: new Date('2026-11-21T12:00:00.000Z'),
      token: 'high-entropy-one-time-secret'
    }),
    revoke: async () => undefined,
    ...overrides
  };
}

test('issue route normalizes allowed input and returns a non-cacheable one-time token', async () => {
  let received: { principal: Principal; workspaceId: string; email: string; role: string } | undefined;
  const service = fakeService({
    issue: async (receivedPrincipal, requestedWorkspaceId, input) => {
      received = { principal: receivedPrincipal, workspaceId: requestedWorkspaceId, ...input };
      return {
        id: invitationId,
        ...input,
        expiresAt: new Date('2026-11-21T12:00:00.000Z'),
        token: 'high-entropy-one-time-secret'
      };
    }
  });
  const server = await listen(appWith(service));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://trusted.example', 'x-user-id': 'attacker', 'x-workspace-role': 'owner' },
      body: JSON.stringify({ email: ' PERSON@Example.Test ', role: 'member' })
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(received, { principal, workspaceId, email: 'person@example.test', role: 'member' });
    assert.deepEqual(await response.json(), {
      data: { id: invitationId, email: 'person@example.test', role: 'member', expiresAt: '2026-11-21T12:00:00.000Z', token: 'high-entropy-one-time-secret' }
    });
  } finally { await server.close(); }
});

test('issue route rejects owner role, extra fields, invalid email, and malformed scope before service calls', async () => {
  let calls = 0;
  const server = await listen(appWith(fakeService({ issue: async () => {
    calls++;
    throw new Error('invalid input reached invitation service');
  } })));
  try {
    const invalidRequests = [
      { path: `/api/v1/workspaces/${workspaceId}/invitations`, body: { email: 'person@example.test', role: 'owner' } },
      { path: `/api/v1/workspaces/${workspaceId}/invitations`, body: { email: 'not-an-email', role: 'member' } },
      { path: `/api/v1/workspaces/${workspaceId}/invitations`, body: { email: 'person@example.test', role: 'member', tokenHash: 'attacker-value' } },
      { path: `/api/v1/workspaces/${workspaceId}/invitations`, body: { email: 'person@example.test', role: 'member', expiresAt: '2099-01-01T00:00:00Z' } },
      { path: '/api/v1/workspaces/not-a-uuid/invitations', body: { email: 'person@example.test', role: 'member' } }
    ];
    for (const invalid of invalidRequests) {
      const response = await fetch(`${server.baseUrl}${invalid.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://trusted.example' },
        body: JSON.stringify(invalid.body)
      });
      assert.equal(response.status, 400);
      const body = await response.text();
      assert.equal(body.includes('person@example.test'), false);
      assert.equal(body.includes('attacker-value'), false);
    }
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('issue and revoke routes remain protected by the configured session authenticator', async () => {
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test', PUBLIC_ORIGIN: 'https://trusted.example' }),
    authenticator: new UnconfiguredAuthenticator(),
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService: fakeService(),
    teamService: { listVisibleToPrincipal: async () => [], createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); } },
    membershipService: { changeRoleForPrincipal: async () => undefined, removeMemberForPrincipal: async () => undefined, transferOwnershipForPrincipal: async () => undefined, leaveWorkspaceForPrincipal: async () => undefined }
  });
  const server = await listen(app);
  try {
    const issue = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://trusted.example' },
      body: JSON.stringify({ email: 'person@example.test', role: 'member' })
    });
    const revoke = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`, {
      method: 'DELETE', headers: { origin: 'https://trusted.example' }
    });
    assert.equal(issue.status, 401);
    assert.equal(revoke.status, 401);
  } finally { await server.close(); }
});

test('revoke route validates identifiers and returns no invitation token or body', async () => {
  let received: { principal: Principal; workspaceId: string; invitationId: string } | undefined;
  const server = await listen(appWith(fakeService({ revoke: async (receivedPrincipal, requestedWorkspaceId, requestedInvitationId) => {
    received = { principal: receivedPrincipal, workspaceId: requestedWorkspaceId, invitationId: requestedInvitationId };
  } })));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`, {
      method: 'DELETE', headers: { origin: 'https://trusted.example' }
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.deepEqual(received, { principal, workspaceId, invitationId });
  } finally { await server.close(); }
});
