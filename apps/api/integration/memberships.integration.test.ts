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
import { PrismaMembershipRepository } from '../src/memberships/prisma-membership-repository.js';
import { WorkspaceMembershipService } from '../src/memberships/membership-service.js';
import { PrismaTeamRepository } from '../src/teams/prisma-team-repository.js';
import { TeamService } from '../src/teams/team-service.js';
import { pool, prisma, removeTestAuditEvents } from './test-database.js';

const trustedOrigin = 'http://127.0.0.1';

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, provider_subject, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, `membership-test:${label}:${id}`, `${id}@example.test`, `Membership ${label}`]
  );
  return id;
}

async function startAs(userId: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const principal: Principal = { userId, sessionId: `membership-test:${userId}` };
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function request(baseUrl: string, path: string, method: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { origin: trustedOrigin }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, ...(response.status === 204 ? {} : { body: await response.json() as { error?: { code?: string } } }) };
}

async function createFixture(label: string) {
  const ids = {
    owner: await createUser(`${label}-owner`),
    admin: await createUser(`${label}-admin`),
    member: await createUser(`${label}-member`),
    secondMember: await createUser(`${label}-second-member`),
    outsider: await createUser(`${label}-outsider`)
  };
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(
      'INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)',
      [workspaceId, `Membership ${label}`, `membership-${workspaceId.slice(0, 8)}`, otherWorkspaceId, `Other ${label}`, `other-${otherWorkspaceId.slice(0, 8)}`]
    );
    await setup.query(
      `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES
        ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($6, $7, 'owner')`,
      [workspaceId, ids.owner, ids.admin, ids.member, ids.secondMember, otherWorkspaceId, ids.outsider]
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally { setup.release(); }
  return { ids, workspaceId, otherWorkspaceId };
}

async function roles(workspaceId: string): Promise<Record<string, string>> {
  const result = await pool.query('SELECT user_id, role FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
  return Object.fromEntries(result.rows.map((row: { user_id: string; role: string }) => [row.user_id, row.role]));
}

async function auditEvents(workspaceId: string): Promise<Array<{ event_kind: string; actor_user_id: string | null; metadata: Record<string, string> }>> {
  const result = await pool.query(
    `SELECT event_kind::text, actor_user_id::text, metadata
     FROM security_audit_events WHERE workspace_id = $1::uuid ORDER BY created_at, id`,
    [workspaceId],
  );
  return result.rows;
}

async function cleanupFixtures(workspaceIds: string[], userIds: string[]): Promise<void> {
  await removeTestAuditEvents(workspaceIds);
  await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

test('membership role changes and removal enforce current roles, target roles, and workspace scope', async () => {
  const fixture = await createFixture('roles');
  const createdUsers = Object.values(fixture.ids);
  const createdWorkspaces = [fixture.workspaceId, fixture.otherWorkspaceId];
  try {
    const owner = await startAs(fixture.ids.owner);
    const admin = await startAs(fixture.ids.admin);
    const outsider = await startAs(fixture.ids.outsider);
    try {
      const base = `/api/v1/workspaces/${fixture.workspaceId}`;
      assert.equal((await request(owner.baseUrl, `${base}/members/${fixture.ids.member}`, 'PATCH', { role: 'admin' })).status, 204);
      assert.equal((await roles(fixture.workspaceId))[fixture.ids.member], 'admin');
      assert.equal((await request(admin.baseUrl, `${base}/members/${fixture.ids.secondMember}`, 'PATCH', { role: 'admin' })).status, 403);
      assert.equal((await request(admin.baseUrl, `${base}/members/${fixture.ids.member}`, 'DELETE')).status, 403, 'admins cannot remove another administrator');
      assert.equal((await request(owner.baseUrl, `${base}/members/${fixture.ids.member}`, 'PATCH', { role: 'admin' })).status, 409, 'unchanged role is rejected');
      assert.equal((await request(admin.baseUrl, `${base}/members/${fixture.ids.secondMember}`, 'DELETE')).status, 204);
      assert.equal((await request(owner.baseUrl, `${base}/members/${fixture.ids.member}`, 'PATCH', { role: 'member' })).status, 204, 'owner can demote an administrator');
      assert.equal((await request(owner.baseUrl, `${base}/members/${fixture.ids.member}`, 'DELETE')).status, 204, 'owner can remove an administrator');
      assert.equal((await request(outsider.baseUrl, `${base}/members/${fixture.ids.member}`, 'DELETE')).status, 404, 'membership in another workspace does not authorize this tenant');
      assert.equal((await request(owner.baseUrl, `/api/v1/workspaces/${fixture.otherWorkspaceId}/members/${fixture.ids.member}`, 'DELETE')).status, 404, 'target membership is workspace-scoped');
      const after = await roles(fixture.workspaceId);
      assert.equal(after[fixture.ids.owner], 'owner');
      assert.equal(after[fixture.ids.member], undefined);
      assert.equal(after[fixture.ids.secondMember], undefined);
      const events = await auditEvents(fixture.workspaceId);
      assert.equal(events.length, 4);
      assert.deepEqual(events.map(({ event_kind, actor_user_id, metadata }) => ({ event_kind, actor_user_id, metadata })), [
        { event_kind: 'workspace_membership_role_changed', actor_user_id: fixture.ids.owner, metadata: { target_user_id: fixture.ids.member, role_before: 'member', role_after: 'admin' } },
        { event_kind: 'workspace_membership_removed', actor_user_id: fixture.ids.admin, metadata: { target_user_id: fixture.ids.secondMember, role_before: 'member' } },
        { event_kind: 'workspace_membership_role_changed', actor_user_id: fixture.ids.owner, metadata: { target_user_id: fixture.ids.member, role_before: 'admin', role_after: 'member' } },
        { event_kind: 'workspace_membership_removed', actor_user_id: fixture.ids.owner, metadata: { target_user_id: fixture.ids.member, role_before: 'member' } },
      ]);
    } finally { await Promise.all([owner.close(), admin.close(), outsider.close()]); }
  } finally {
    await cleanupFixtures(createdWorkspaces, createdUsers);
  }
});

test('ownership transfer and leave are atomic and preserve exactly one owner', async () => {
  const fixture = await createFixture('transfer');
  const createdUsers = Object.values(fixture.ids);
  const createdWorkspaces = [fixture.workspaceId, fixture.otherWorkspaceId];
  try {
    const owner = await startAs(fixture.ids.owner);
    const admin = await startAs(fixture.ids.admin);
    try {
      const base = `/api/v1/workspaces/${fixture.workspaceId}`;
      assert.equal((await request(owner.baseUrl, `${base}/ownership/transfer`, 'POST', { targetUserId: fixture.ids.admin })).status, 204);
      let current = await roles(fixture.workspaceId);
      assert.equal(current[fixture.ids.owner], 'admin');
      assert.equal(current[fixture.ids.admin], 'owner');
      assert.equal((await request(owner.baseUrl, `${base}/ownership/transfer`, 'POST', { targetUserId: fixture.ids.member })).status, 403, 'former owner cannot transfer a second time');
      assert.equal((await request(admin.baseUrl, `${base}/membership`, 'DELETE')).status, 409, 'owner must include transfer target before leaving');
      assert.equal((await request(admin.baseUrl, `${base}/membership`, 'DELETE', { transferToUserId: fixture.ids.member })).status, 204);
      current = await roles(fixture.workspaceId);
      assert.equal(current[fixture.ids.admin], undefined, 'departing owner membership is removed');
      assert.equal(current[fixture.ids.member], 'owner', 'the transfer target becomes owner in the same transaction');
      assert.equal(Object.values(current).filter((role) => role === 'owner').length, 1);
      assert.equal((await request(owner.baseUrl, `${base}/membership`, 'DELETE')).status, 204, 'a regular member can leave without transfer');
      const events = await auditEvents(fixture.workspaceId);
      assert.deepEqual(events.map(({ event_kind, actor_user_id, metadata }) => ({ event_kind, actor_user_id, metadata })), [
        { event_kind: 'workspace_owner_transferred', actor_user_id: fixture.ids.owner, metadata: { previous_owner_user_id: fixture.ids.owner, new_owner_user_id: fixture.ids.admin } },
        { event_kind: 'workspace_owner_transferred', actor_user_id: fixture.ids.admin, metadata: { previous_owner_user_id: fixture.ids.admin, new_owner_user_id: fixture.ids.member } },
        { event_kind: 'workspace_membership_removed', actor_user_id: fixture.ids.admin, metadata: { target_user_id: fixture.ids.admin, role_before: 'admin' } },
        { event_kind: 'workspace_membership_removed', actor_user_id: fixture.ids.owner, metadata: { target_user_id: fixture.ids.owner, role_before: 'admin' } },
      ]);
    } finally { await Promise.all([owner.close(), admin.close()]); }
  } finally {
    await cleanupFixtures(createdWorkspaces, createdUsers);
  }
});

test('parallel ownership transfers serialize and reauthorize after the first transfer', async () => {
  const fixture = await createFixture('concurrent');
  const createdUsers = Object.values(fixture.ids);
  const createdWorkspaces = [fixture.workspaceId, fixture.otherWorkspaceId];
  try {
    const repository = new PrismaMembershipRepository(prisma);
    const outcomes = await Promise.allSettled([
      repository.transferOwnership({ workspaceId: fixture.workspaceId, actorUserId: fixture.ids.owner, targetUserId: fixture.ids.admin }),
      repository.transferOwnership({ workspaceId: fixture.workspaceId, actorUserId: fixture.ids.owner, targetUserId: fixture.ids.member })
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    assert.ok(rejected);
    assert.equal((rejected.reason as { statusCode?: number }).statusCode, 403, 'serialized second request sees the former owner role');
    const current = await roles(fixture.workspaceId);
    assert.equal(current[fixture.ids.owner], 'admin');
    assert.equal(Object.values(current).filter((role) => role === 'owner').length, 1);
    const events = await auditEvents(fixture.workspaceId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_kind, 'workspace_owner_transferred');
    assert.equal(events[0]?.actor_user_id, fixture.ids.owner);
  } finally {
    await cleanupFixtures(createdWorkspaces, createdUsers);
  }
});

test('deferred owner constraint allows a temporary ownerless transfer but rejects ownerless commit', async () => {
  const fixture = await createFixture('deferred');
  const createdUsers = Object.values(fixture.ids);
  const createdWorkspaces = [fixture.workspaceId, fixture.otherWorkspaceId];
  try {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("UPDATE workspace_memberships SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2", [fixture.workspaceId, fixture.ids.owner]);
      const ownerless = await connection.query("SELECT count(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'", [fixture.workspaceId]);
      assert.equal(ownerless.rows[0].count, 0, 'the trigger is deferred until transaction commit');
      await connection.query("UPDATE workspace_memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [fixture.workspaceId, fixture.ids.admin]);
      await connection.query('COMMIT');

      await connection.query('BEGIN');
      await connection.query('DELETE FROM workspace_memberships WHERE workspace_id = $1 AND role = \'owner\'', [fixture.workspaceId]);
      await assert.rejects(connection.query('COMMIT'), (error: { code?: string; constraint?: string }) => error.code === '23514' && error.constraint === 'workspace_exactly_one_owner');
      await connection.query('ROLLBACK');
    } finally { connection.release(); }
  } finally {
    await cleanupFixtures(createdWorkspaces, createdUsers);
  }
});
