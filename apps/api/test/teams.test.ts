import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { UnconfiguredAuthenticator } from '../src/auth/authenticator.js';
import type { IssuedInvitationRecord } from '../src/invitations/invitation-repository.js';
import type { InvitationAdministrator } from '../src/invitations/invitation-service.js';
import type { TeamSummary } from '../src/teams/team-repository.js';
import type { TeamAdministrator, TeamLister } from '../src/teams/team-service.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const principal = { userId: '49a03ed2-7eb3-4c00-a8e1-519c70306427', sessionId: 'session-1' };
const teams: TeamSummary[] = [{ id: 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a', name: 'Product', key: 'PROD', visibility: 'workspace' }];
const invitationService: InvitationAdministrator = {
  redeem: async () => ({ workspaceId, role: 'member' }),
  issue: async (): Promise<IssuedInvitationRecord & { token: string }> => { throw new Error('Invitation issue is not exercised in team tests'); },
  revoke: async () => undefined
};

type TeamServiceFixture = TeamLister & TeamAdministrator;

function appWith(teamService: TeamServiceFixture) {
  return buildApp({
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test', PUBLIC_ORIGIN: 'https://trusted.example' }),
    authenticator: {
      configured: true,
      authenticate: async () => principal
    },
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService,
    teamService,
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

test('team listing validates workspace UUID before calling the service', async () => {
  let calls = 0;
  const server = await listen(appWith({ listVisibleToPrincipal: async () => { calls++; return teams; }, createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); } }));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/not-a-uuid/teams`);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'invalid_request');
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('team listing passes authenticated principal and workspace scope, ignoring identity headers', async () => {
  let received: { principal: typeof principal; workspaceId: string } | undefined;
  const server = await listen(appWith({
    listVisibleToPrincipal: async (receivedPrincipal, receivedWorkspaceId) => {
      received = { principal: receivedPrincipal, workspaceId: receivedWorkspaceId };
      return teams;
    }, createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }
  }));
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams`, {
      headers: { 'x-user-id': 'attacker-user', 'x-workspace-role': 'owner' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: teams });
    assert.deepEqual(received, { principal, workspaceId });
  } finally { await server.close(); }
});

test('team listing requires authenticated session principal', async () => {
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test', PUBLIC_ORIGIN: 'https://trusted.example' }),
    authenticator: new UnconfiguredAuthenticator(),
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService,
    teamService: { listVisibleToPrincipal: async () => teams, createForPrincipal: async () => { throw new Error('Not exercised'); }, addPrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); }, removePrivateMemberForPrincipal: async () => { throw new Error('Not exercised'); } },
    membershipService: { changeRoleForPrincipal: async () => undefined, removeMemberForPrincipal: async () => undefined, transferOwnershipForPrincipal: async () => undefined, leaveWorkspaceForPrincipal: async () => undefined }
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/${workspaceId}/teams`);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unauthenticated');
  } finally { await server.close(); }
});
