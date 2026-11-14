import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/authenticator.js';
import { loadConfig } from '../src/config/config.js';
import { PrismaTeamRepository } from '../src/teams/prisma-team-repository.js';
import { TeamService } from '../src/teams/team-service.js';
import { PrismaMembershipRepository } from '../src/memberships/prisma-membership-repository.js';
import { WorkspaceMembershipService } from '../src/memberships/membership-service.js';
import { InvitationService } from '../src/invitations/invitation-service.js';
import { PrismaInvitationRepository } from '../src/invitations/prisma-invitation-repository.js';
import { pool, prisma } from './test-database.js';

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, provider_subject, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, `teams-integration:${label}:${id}`, `${id}@example.test`, `Teams ${label}`],
  );
  return id;
}

async function requestTeamsAs(userId: string, workspaceId: string): Promise<unknown> {
  const principal: Principal = { userId, sessionId: `integration:${userId}` };
  const app = buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL!,
      PUBLIC_ORIGIN: 'http://127.0.0.1'
    }),
    authenticator: { configured: true, authenticate: async () => principal },
    readinessProbe: { query: async () => undefined },
    workspaceService: { listForPrincipal: async () => [] },
    invitationService: new InvitationService(new PrismaInvitationRepository(prisma)),
    teamService: new TeamService(new PrismaTeamRepository(prisma)),
    membershipService: new WorkspaceMembershipService(new PrismaMembershipRepository(prisma))
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/workspaces/${workspaceId}/teams`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('workspace team listing scopes workspace visibility and requires explicit private-team membership', async () => {
  const ownerId = await createUser('owner');
  const adminId = await createUser('admin');
  const memberId = await createUser('member');
  const outsiderId = await createUser('outsider');
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const createdUsers = [ownerId, adminId, memberId, outsiderId];
  const createdWorkspaces = [workspaceId, otherWorkspaceId];
  const teamIds: Record<string, string> = {};
  const teamKeys: Record<string, string> = {};

  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query(
        `INSERT INTO workspaces(id, name, slug) VALUES
         ($1, 'Teams visibility workspace', $2),
         ($3, 'Other visibility workspace', $4)`,
        [workspaceId, `teams-${workspaceId.slice(0, 8)}`, otherWorkspaceId, `other-${otherWorkspaceId.slice(0, 8)}`],
      );
      await setup.query(
        `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES
         ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($5, $6, 'owner')`,
        [workspaceId, ownerId, adminId, memberId, otherWorkspaceId, outsiderId],
      );
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally { setup.release(); }

    const addTeam = async (label: string, workspace: string, visibility: 'workspace' | 'private') => {
      const teamId = randomUUID();
      const key = `T${teamId.slice(0, 6).toUpperCase()}`;
      await pool.query(
        'INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES ($1, $2, $3, $4, $5)',
        [teamId, workspace, `Team ${label}`, key, visibility],
      );
      teamIds[label] = teamId;
      teamKeys[label] = key;
      return teamId;
    };
    await addTeam('public', workspaceId, 'workspace');
    const privateForMember = await addTeam('privateMember', workspaceId, 'private');
    await addTeam('privateUnassigned', workspaceId, 'private');
    await addTeam('otherWorkspace', otherWorkspaceId, 'workspace');
    await pool.query(
      'INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)',
      [workspaceId, privateForMember, memberId],
    );

    const ownerListing = await requestTeamsAs(ownerId, workspaceId) as { status: number; body: { data: Array<{ id: string; name: string; key: string; visibility: string }> } };
    const adminListing = await requestTeamsAs(adminId, workspaceId) as { status: number; body: { data: Array<{ id: string; name: string; key: string; visibility: string }> } };
    const memberListing = await requestTeamsAs(memberId, workspaceId) as { status: number; body: { data: Array<{ id: string; name: string; key: string; visibility: string }> } };
    const outsiderListing = await requestTeamsAs(outsiderId, workspaceId) as { status: number; body: { data: Array<{ id: string; name: string; key: string; visibility: string }> } };

    for (const listing of [ownerListing, adminListing, memberListing, outsiderListing]) assert.equal(listing.status, 200);
    const expected = (labels: Array<'public' | 'privateMember'>) => labels
      .map((label) => ({
        id: teamIds[label],
        name: `Team ${label}`,
        key: teamKeys[label],
        visibility: label === 'public' ? 'workspace' : 'private'
      }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
    assert.deepEqual(ownerListing.body.data, expected(['public']));
    assert.deepEqual(adminListing.body.data, expected(['public']));
    assert.deepEqual(memberListing.body.data, expected(['privateMember', 'public']));
    assert.deepEqual(outsiderListing.body.data, []);
  } finally {
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [createdWorkspaces]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]);
  }
});
