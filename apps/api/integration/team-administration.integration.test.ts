import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/authenticator.js';
import { loadConfig } from '../src/config/config.js';
import { PrismaInvitationRepository } from '../src/invitations/prisma-invitation-repository.js';
import { InvitationService } from '../src/invitations/invitation-service.js';
import { PrismaTeamRepository } from '../src/teams/prisma-team-repository.js';
import { TeamService } from '../src/teams/team-service.js';
import { PrismaMembershipRepository } from '../src/memberships/prisma-membership-repository.js';
import { WorkspaceMembershipService } from '../src/memberships/membership-service.js';
import { pool, prisma, removeTestAuditEvents } from './test-database.js';

const trustedOrigin = 'http://127.0.0.1';

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, provider_subject, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, `team-admin:${label}:${id}`, `${id}@example.test`, `Team admin ${label}`]
  );
  return id;
}

async function callAs(userId: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body?: unknown }> {
  const principal: Principal = { userId, sessionId: `integration:${userId}` };
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL!, PUBLIC_ORIGIN: trustedOrigin }),
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
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { origin: trustedOrigin }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, ...(response.status === 204 ? {} : { body: await response.json() }) };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('team creation and private membership administration enforce current workspace roles and tenant scope', async () => {
  const ownerId = await createUser('owner');
  const adminId = await createUser('admin');
  const memberId = await createUser('member');
  const disabledId = await createUser('disabled-member');
  const outsiderId = await createUser('outsider');
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const createdUsers = [ownerId, adminId, memberId, disabledId, outsiderId];
  const createdWorkspaces = [workspaceId, otherWorkspaceId];
  let privateTeamId = '';
  let workspaceTeamId = '';
  let otherTeamId = '';

  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query(
        `INSERT INTO workspaces(id, name, slug) VALUES
         ($1, 'Team administration workspace', $2),
         ($3, 'Other team administration workspace', $4)`,
        [workspaceId, `team-admin-${workspaceId.slice(0, 8)}`, otherWorkspaceId, `other-admin-${otherWorkspaceId.slice(0, 8)}`]
      );
      await setup.query(
        `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES
         ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($6, $7, 'owner')`,
        [workspaceId, ownerId, adminId, memberId, disabledId, otherWorkspaceId, outsiderId]
      );
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally { setup.release(); }

    const teamsPath = `/api/v1/workspaces/${workspaceId}/teams`;
    const create = async (name: string, key: string, visibility: 'workspace' | 'private') =>
      callAs(ownerId, teamsPath, 'POST', { name, key, visibility });
    const privateCreate = await create('Private core', `P${randomUUID().slice(0, 5).toUpperCase()}`, 'private');
    const workspaceCreate = await create('Workspace core', `W${randomUUID().slice(0, 5).toUpperCase()}`, 'workspace');
    const adminCreate = await callAs(adminId, teamsPath, 'POST', { name: 'Admin team', key: `A${randomUUID().slice(0, 5).toUpperCase()}`, visibility: 'private' });
    const memberCreate = await callAs(memberId, teamsPath, 'POST', { name: 'Forbidden', key: `F${randomUUID().slice(0, 5).toUpperCase()}`, visibility: 'private' });
    const outsiderCreate = await callAs(outsiderId, teamsPath, 'POST', { name: 'Other tenant', key: `O${randomUUID().slice(0, 5).toUpperCase()}`, visibility: 'workspace' });

    assert.equal(privateCreate.status, 201);
    assert.equal(workspaceCreate.status, 201);
    assert.equal(adminCreate.status, 201);
    assert.equal(memberCreate.status, 403);
    assert.equal(outsiderCreate.status, 404);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [adminId]);
    assert.equal((await callAs(adminId, teamsPath, 'POST', { name: 'Disabled admin', key: `D${randomUUID().slice(0, 5).toUpperCase()}`, visibility: 'private' })).status, 404);
    await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [adminId]);
    privateTeamId = (privateCreate.body as { data: { id: string } }).data.id;
    workspaceTeamId = (workspaceCreate.body as { data: { id: string } }).data.id;
    otherTeamId = randomUUID();
    await pool.query(
      'INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES ($1, $2, $3, $4, $5)',
      [otherTeamId, otherWorkspaceId, 'Cross tenant team', `X${otherTeamId.slice(0, 5).toUpperCase()}`, 'private']
    );

    const privatePath = `${teamsPath}/${privateTeamId}/members/${memberId}`;
    assert.equal((await callAs(adminId, privatePath, 'POST')).status, 204);
    const memberListing = await callAs(memberId, teamsPath);
    assert.equal(memberListing.status, 200);
    assert.ok((memberListing.body as { data: Array<{ id: string }> }).data.some(({ id }) => id === privateTeamId));

    const adminListing = await callAs(adminId, teamsPath);
    assert.equal(adminListing.status, 200);
    assert.ok(!(adminListing.body as { data: Array<{ id: string }> }).data.some(({ id }) => id === privateTeamId), 'administrator role does not bypass private-team visibility');

    assert.equal((await callAs(memberId, `${teamsPath}/${privateTeamId}/members/${ownerId}`, 'POST')).status, 403);
    assert.equal((await callAs(ownerId, `${teamsPath}/${privateTeamId}/members/${outsiderId}`, 'POST')).status, 404);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabledId]);
    assert.equal((await callAs(ownerId, `${teamsPath}/${privateTeamId}/members/${disabledId}`, 'POST')).status, 404);
    await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [disabledId]);
    assert.equal((await callAs(ownerId, `${teamsPath}/${workspaceTeamId}/members/${memberId}`, 'POST')).status, 409);
    assert.equal((await callAs(ownerId, `/api/v1/workspaces/${workspaceId}/teams/${otherTeamId}/members/${memberId}`, 'POST')).status, 404);

    assert.equal((await callAs(ownerId, privatePath, 'DELETE')).status, 204);
    const memberAfterRemoval = await callAs(memberId, teamsPath);
    assert.ok(!(memberAfterRemoval.body as { data: Array<{ id: string }> }).data.some(({ id }) => id === privateTeamId));
    const adminMemberPath = `${teamsPath}/${privateTeamId}/members/${adminId}`;
    assert.equal((await callAs(ownerId, adminMemberPath, 'POST')).status, 204);
    assert.equal((await callAs(adminId, adminMemberPath, 'DELETE')).status, 204);
  } finally {
    await removeTestAuditEvents(createdWorkspaces);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [createdWorkspaces]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]);
  }
});
