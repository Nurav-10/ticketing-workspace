import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import type { IssuedInvitationRecord } from '../src/invitations/invitation-repository.js';
import type { InvitationAdministrator } from '../src/invitations/invitation-service.js';
import type { TeamManagementPage, TeamMemberManagementRecord, TeamSummary } from '../src/teams/team-repository.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const trustedOrigin = 'https://trusted.example';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const memberId = '7cfe1264-e3c5-4176-9f10-a48af105a1c8';
const principal = { userId: '49a03ed2-7eb3-4c00-a8e1-519c70306427', sessionId: 'session-1' };
const created: TeamSummary = { id: teamId, name: 'Product', key: 'PROD', visibility: 'private' };
const roster: TeamMemberManagementRecord[] = [{ id: memberId, email: 'member@example.test', displayName: 'Member', role: 'member', isTeamMember: false }];
const rosterPage: TeamManagementPage<TeamMemberManagementRecord> = { data: roster, hasMore: false, nextCursor: null };
const privateTeamPage: TeamManagementPage<TeamSummary> = { data: [created], hasMore: false, nextCursor: null };
const invitationService: InvitationAdministrator = {
  redeem: async () => ({ workspaceId, role: 'member' }),
  issue: async (): Promise<IssuedInvitationRecord & { token: string }> => { throw new Error('Not exercised'); },
  listPending: async () => [],
  revoke: async () => undefined
};

async function listen(app: ReturnType<typeof buildApp>): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function makeApp(overrides: Partial<{
  create: (receivedPrincipal: typeof principal, input: { workspaceId: string; name: string; key: string; visibility: 'workspace' | 'private' }) => Promise<TeamSummary>;
  add: (receivedPrincipal: typeof principal, input: { workspaceId: string; teamId: string; targetUserId: string }) => Promise<void>;
  remove: (receivedPrincipal: typeof principal, input: { workspaceId: string; teamId: string; targetUserId: string }) => Promise<void>;
  listMembers: (receivedPrincipal: typeof principal, input: { workspaceId: string; teamId: string; limit: number; cursor?: string }) => Promise<TeamManagementPage<TeamMemberManagementRecord>>;
  listTeams: (receivedPrincipal: typeof principal, input: { workspaceId: string; limit: number; cursor?: string }) => Promise<TeamManagementPage<TeamSummary>>;
}> = {}) {
  return buildApp({
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test', PUBLIC_ORIGIN: trustedOrigin }),
    authenticator: { configured: true, authenticate: async () => principal },
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService,
    teamService: {
      listVisibleToPrincipal: async () => [],
      createForPrincipal: overrides.create ?? (async () => created),
      addPrivateMemberForPrincipal: overrides.add ?? (async () => undefined),
      removePrivateMemberForPrincipal: overrides.remove ?? (async () => undefined),
      listPrivateMembersForPrincipal: overrides.listMembers ?? (async () => rosterPage),
      listPrivateTeamsForPrincipal: overrides.listTeams ?? (async () => privateTeamPage)
    },
    membershipService: { changeRoleForPrincipal: async () => undefined, removeMemberForPrincipal: async () => undefined, transferOwnershipForPrincipal: async () => undefined, leaveWorkspaceForPrincipal: async () => undefined }
  });
}

test('team creation validates the exact body and passes principal and requested initial visibility', async () => {
  let received: unknown;
  const server = await listen(makeApp({ create: async (receivedPrincipal, input) => { received = { receivedPrincipal, input }; return created; } }));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: trustedOrigin, 'x-user-id': 'forged', 'x-workspace-role': 'owner' },
      body: JSON.stringify({ name: ' Product ', key: 'PROD', visibility: 'private' })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { data: created });
    assert.deepEqual(received, { receivedPrincipal: principal, input: { workspaceId, name: 'Product', key: 'PROD', visibility: 'private' } });
  } finally { await server.close(); }
});

test('team creation rejects client-supplied authority and invalid initial values before service call', async () => {
  let calls = 0;
  const server = await listen(makeApp({ create: async () => { calls++; return created; } }));
  try {
    for (const body of [
      { name: 'Product', key: 'PROD', visibility: 'private', workspaceId },
      { name: 'Product', key: 'bad', visibility: 'private' },
      { name: '   ', key: 'PROD', visibility: 'workspace' },
      { name: 'Product', key: 'PROD', visibility: 'shared' }
    ]) {
      const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: trustedOrigin }, body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.deepEqual((await response.json() as { error: { code: string } }).error.code, 'invalid_request');
    }
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('private-team membership endpoints pass all tenant and target identifiers to the administrator service', async () => {
  const received: unknown[] = [];
  const server = await listen(makeApp({
    add: async (receivedPrincipal, input) => { received.push({ action: 'add', receivedPrincipal, input }); },
    remove: async (receivedPrincipal, input) => { received.push({ action: 'remove', receivedPrincipal, input }); }
  }));
  try {
    const base = `${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams/${teamId}/members/${memberId}`;
    assert.equal((await fetch(base, { method: 'POST', headers: { origin: trustedOrigin } })).status, 204);
    assert.equal((await fetch(base, { method: 'DELETE', headers: { origin: trustedOrigin } })).status, 204);
    assert.deepEqual(received, [
      { action: 'add', receivedPrincipal: principal, input: { workspaceId, teamId, targetUserId: memberId } },
      { action: 'remove', receivedPrincipal: principal, input: { workspaceId, teamId, targetUserId: memberId } }
    ]);
  } finally { await server.close(); }
});

test('private-team membership endpoints validate every UUID and visibility has no mutation endpoint', async () => {
  let calls = 0;
  const server = await listen(makeApp({ add: async () => { calls++; }, remove: async () => { calls++; } }));
  try {
    const invalid = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams/not-a-uuid/members/${memberId}`, { method: 'POST', headers: { origin: trustedOrigin } });
    assert.equal(invalid.status, 400);
    const visibilityChange = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams/${teamId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', origin: trustedOrigin }, body: JSON.stringify({ visibility: 'workspace' })
    });
    assert.equal(visibilityChange.status, 404);
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('private-team roster passes authenticated principal and tenant-scoped team identifiers', async () => {
  let received: unknown;
  const server = await listen(makeApp({ listMembers: async (receivedPrincipal, input) => { received = { receivedPrincipal, input }; return rosterPage; } }));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams/${teamId}/members`, { headers: { origin: trustedOrigin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { data: roster, pageInfo: { hasMore: false, nextCursor: null } });
    assert.deepEqual(received, { receivedPrincipal: principal, input: { workspaceId, teamId, limit: 50 } });
  } finally { await server.close(); }
});

test('private-team roster parses bounded page size and UUID cursor', async () => {
  let received: unknown;
  const server = await listen(makeApp({ listMembers: async (receivedPrincipal, input) => { received = { receivedPrincipal, input }; return { data: [], hasMore: true, nextCursor: memberId }; } }));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams/${teamId}/members?limit=7&cursor=${memberId}`, { headers: { origin: trustedOrigin } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [], pageInfo: { hasMore: true, nextCursor: memberId } });
    assert.deepEqual(received, { receivedPrincipal: principal, input: { workspaceId, teamId, limit: 7, cursor: memberId } });
  } finally { await server.close(); }
});

test('administrator private-team discovery returns bounded team metadata through its own endpoint', async () => {
  let received: unknown;
  const server = await listen(makeApp({ listTeams: async (receivedPrincipal, input) => { received = { receivedPrincipal, input }; return privateTeamPage; } }));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/private-teams`, { headers: { origin: trustedOrigin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { data: [created], pageInfo: { hasMore: false, nextCursor: null } });
    assert.deepEqual(received, { receivedPrincipal: principal, input: { workspaceId, limit: 50 } });
  } finally { await server.close(); }
});

test('team management page options reject unbounded, malformed, or excessive pagination before service calls', async () => {
  let calls = 0;
  const server = await listen(makeApp({ listMembers: async () => { calls++; return rosterPage; }, listTeams: async () => { calls++; return privateTeamPage; } }));
  try {
    for (const path of [
      `/api/v1/workspaces/${workspaceId}/teams/${teamId}/members?limit=0`,
      `/api/v1/workspaces/${workspaceId}/teams/${teamId}/members?limit=101`,
      `/api/v1/workspaces/${workspaceId}/teams/${teamId}/members?cursor=nope`,
      `/api/v1/workspaces/${workspaceId}/private-teams?limit=999`
    ]) {
      const response = await fetch(`${server.baseUrl}${path}`, { headers: { origin: trustedOrigin } });
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
  } finally { await server.close(); }
});
