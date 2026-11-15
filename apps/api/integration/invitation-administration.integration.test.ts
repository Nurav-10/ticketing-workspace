import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/authenticator.js';
import { loadConfig } from '../src/config/config.js';
import { InvitationService } from '../src/invitations/invitation-service.js';
import { PrismaInvitationRepository } from '../src/invitations/prisma-invitation-repository.js';
import { PrismaTeamRepository } from '../src/teams/prisma-team-repository.js';
import { TeamService } from '../src/teams/team-service.js';
import { PrismaMembershipRepository } from '../src/memberships/prisma-membership-repository.js';
import { WorkspaceMembershipService } from '../src/memberships/membership-service.js';
import { pool, prisma, removeTestAuditEvents } from './test-database.js';

const apiOrigin = 'http://127.0.0.1';

async function createUser(email = `${randomUUID()}@example.test`, verified = true): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, provider_subject, email, email_verified_at, display_name)
     VALUES ($1, $2, $3, $4, 'Invitation administration user')`,
    [id, `invitation-admin:${id}`, email, verified ? new Date() : null],
  );
  return { id, email };
}

async function createWorkspace(ownerId: string): Promise<string> {
  const id = randomUUID();
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [id, 'Invitation admin workspace', `invite-${id.slice(0, 8)}`]);
    await setup.query('INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)', [id, ownerId, 'owner']);
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally { setup.release(); }
  return id;
}

async function addMember(workspaceId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
  await pool.query('INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspaceId, userId, role]);
}

async function requestAs(userId: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const principal: Principal = { userId, sessionId: `invitation-admin:${userId}` };
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL!, PUBLIC_ORIGIN: apiOrigin }),
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
        origin: apiOrigin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const responseBody = response.status === 204 ? null : await response.json();
    return { status: response.status, body: responseBody };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function cleanup(workspaceIds: string[], userIds: string[]): Promise<void> {
  await removeTestAuditEvents(workspaceIds);
  if (workspaceIds.length) {
    await pool.query('DELETE FROM invitations WHERE workspace_id = ANY($1::uuid[]) OR invited_by = ANY($2::uuid[])', [workspaceIds, userIds]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
  } else if (userIds.length) {
    await pool.query('DELETE FROM invitations WHERE invited_by = ANY($1::uuid[])', [userIds]);
  }
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

test('issuance enforces the current role and returns a high-entropy token while storing only its hash', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const owner = await createUser(); users.push(owner.id);
    const admin = await createUser(); users.push(admin.id);
    const member = await createUser(); users.push(member.id);
    const outsider = await createUser(); users.push(outsider.id);
    const invitee = await createUser(); users.push(invitee.id);
    const workspaceId = await createWorkspace(owner.id); workspaces.push(workspaceId);
    await addMember(workspaceId, admin.id, 'admin');
    await addMember(workspaceId, member.id, 'member');

    const ownerIssued = await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: ` ${invitee.email.toUpperCase()} `, role: 'admin' });
    assert.equal(ownerIssued.status, 201);
    const invite = ownerIssued.body.data as { id: string; email: string; role: string; token: string; expiresAt: string };
    assert.equal(invite.email, invitee.email);
    assert.equal(invite.role, 'admin');
    assert.equal(Buffer.from(invite.token, 'base64url').byteLength, 32);
    assert.ok(new Date(invite.expiresAt).getTime() > Date.now());
    assert.ok(new Date(invite.expiresAt).getTime() <= Date.now() + 7 * 24 * 60 * 60 * 1000 + 60_000);

    const stored = await pool.query('SELECT token_hash, email, role FROM invitations WHERE id = $1', [invite.id]);
    assert.deepEqual(stored.rows, [{
      token_hash: createHash('sha256').update(invite.token).digest(),
      email: invitee.email,
      role: 'admin'
    }]);
    assert.deepEqual(Object.keys(invite).sort(), ['email', 'expiresAt', 'id', 'role', 'token']);
    assert.notDeepEqual(stored.rows[0]?.token_hash, Buffer.from(invite.token, 'ascii'));

    const hiddenAdminInviteSearch = await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations/search`, 'POST', { email: invitee.email });
    assert.equal(hiddenAdminInviteSearch.status, 200);
    assert.deepEqual(hiddenAdminInviteSearch.body.data, []);
    const adminIssueAgainstHiddenInvite = await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: invitee.email, role: 'member' });
    assert.equal(adminIssueAgainstHiddenInvite.status, 409);
    assert.equal(adminIssueAgainstHiddenInvite.body.error.code, 'invitation_conflict');
    assert.equal(adminIssueAgainstHiddenInvite.body.error.message.includes(invitee.email), false);
    const ownerIssueAgainstAdminInvite = await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: invitee.email, role: 'member' });
    assert.equal(ownerIssueAgainstAdminInvite.status, 409);
    assert.equal(ownerIssueAgainstAdminInvite.body.error.code, 'invitation_exists');

    const adminIssueAgainstExistingMember = await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: member.email, role: 'member' });
    assert.equal(adminIssueAgainstExistingMember.status, 409);
    assert.equal(adminIssueAgainstExistingMember.body.error.code, 'invitation_conflict');
    assert.equal(adminIssueAgainstExistingMember.body.error.message.includes(member.email), false);
    const ownerIssueAgainstExistingMember = await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: member.email, role: 'member' });
    assert.equal(ownerIssueAgainstExistingMember.status, 409);
    assert.equal(ownerIssueAgainstExistingMember.body.error.code, 'already_a_member');

    const visibleMemberInvite = await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'member' });
    assert.equal(visibleMemberInvite.status, 201);
    const adminIssueAgainstVisibleMemberInvite = await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: visibleMemberInvite.body.data.email, role: 'member' });
    assert.equal(adminIssueAgainstVisibleMemberInvite.status, 409);
    assert.equal(adminIssueAgainstVisibleMemberInvite.body.error.code, 'invitation_conflict');
    const ownerIssueAgainstMemberInvite = await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: visibleMemberInvite.body.data.email, role: 'member' });
    assert.equal(ownerIssueAgainstMemberInvite.status, 409);
    assert.equal(ownerIssueAgainstMemberInvite.body.error.code, 'invitation_exists');

    const ownerMemberIssued = await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'member' });
    assert.equal(ownerMemberIssued.status, 201);
    const adminMemberIssued = await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'member' });
    assert.equal(adminMemberIssued.status, 201);
    assert.equal((await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations/${invite.id}`, 'DELETE')).status, 403);
    assert.equal((await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations/${adminMemberIssued.body.data.id}`, 'DELETE')).status, 204);
    assert.equal((await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations/${invite.id}`, 'DELETE')).status, 204);
    assert.equal((await requestAs(admin.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'admin' })).status, 403);
    assert.equal((await requestAs(member.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'member' })).status, 403);
    assert.equal((await requestAs(outsider.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'member' })).status, 404);
    assert.equal((await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'owner' })).status, 400);
    assert.equal((await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: `${randomUUID()}@example.test`, role: 'member', invitedBy: outsider.id })).status, 400);
  } finally { await cleanup(workspaces, users); }
});

test('revocation is tenant-scoped and idempotent, while redeemed invitations conflict', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const ownerA = await createUser(); users.push(ownerA.id);
    const ownerB = await createUser(); users.push(ownerB.id);
    const recipient = await createUser(); users.push(recipient.id);
    const workspaceA = await createWorkspace(ownerA.id); workspaces.push(workspaceA);
    const workspaceB = await createWorkspace(ownerB.id); workspaces.push(workspaceB);

    const revokeInvite = await requestAs(ownerA.id, `/api/v1/workspaces/${workspaceA}/invitations`, 'POST', { email: recipient.email, role: 'member' });
    const revokedId = revokeInvite.body.data.id as string;
    assert.equal((await requestAs(ownerB.id, `/api/v1/workspaces/${workspaceB}/invitations/${revokedId}`, 'DELETE')).status, 404);
    assert.equal((await requestAs(ownerA.id, `/api/v1/workspaces/${workspaceA}/invitations/${revokedId}`, 'DELETE')).status, 204);
    assert.equal((await requestAs(ownerA.id, `/api/v1/workspaces/${workspaceA}/invitations/${revokedId}`, 'DELETE')).status, 204);

    const redeemedInvite = await requestAs(ownerA.id, `/api/v1/workspaces/${workspaceA}/invitations`, 'POST', { email: recipient.email, role: 'member' });
    const redeem = await requestAs(recipient.id, '/api/v1/invitations/redeem', 'POST', { token: redeemedInvite.body.data.token });
    assert.equal(redeem.status, 200);
    assert.equal((await requestAs(recipient.id, '/api/v1/invitations/redeem', 'POST', { token: redeemedInvite.body.data.token })).status, 404);
    assert.equal((await requestAs(ownerA.id, `/api/v1/workspaces/${workspaceA}/invitations/${redeemedInvite.body.data.id}`, 'DELETE')).status, 409);
  } finally { await cleanup(workspaces, users); }
});

test('pending invitation recovery is bounded, workspace-authorized, and enables safe revoke and reissue', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const owner = await createUser(); users.push(owner.id);
    const admin = await createUser(); users.push(admin.id);
    const member = await createUser(); users.push(member.id);
    const outsider = await createUser(); users.push(outsider.id);
    const workspaceId = await createWorkspace(owner.id); workspaces.push(workspaceId);
    await addMember(workspaceId, admin.id, 'admin');
    await addMember(workspaceId, member.id, 'member');

    const path = `/api/v1/workspaces/${workspaceId}/invitations`;
    const lostResponseInvite = await requestAs(owner.id, path, 'POST', { email: `${randomUUID()}@example.test`, role: 'member' });
    const secondInvite = await requestAs(owner.id, path, 'POST', { email: `${randomUUID()}@example.test`, role: 'admin' });
    assert.equal(lostResponseInvite.status, 201);
    assert.equal(secondInvite.status, 201);

    const ownerList = await requestAs(owner.id, `${path}?limit=1`);
    assert.equal(ownerList.status, 200);
    assert.equal(ownerList.body.data.length, 1);
    assert.ok([lostResponseInvite.body.data.id, secondInvite.body.data.id].includes(ownerList.body.data[0].id));

    const exactEmailList = await requestAs(admin.id, `${path}/search`, 'POST', { email: ` ${lostResponseInvite.body.data.email.toUpperCase()} ` });
    assert.equal(exactEmailList.status, 200);
    assert.equal(exactEmailList.body.data.length, 1);
    assert.equal(exactEmailList.body.data[0].id, lostResponseInvite.body.data.id);

    const adminList = await requestAs(admin.id, path);
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.data.length, 1);
    for (const invite of adminList.body.data) {
      assert.deepEqual(Object.keys(invite).sort(), ['email', 'expiresAt', 'id', 'role']);
      assert.equal(invite.role, 'member');
      assert.equal(JSON.stringify(invite).includes('token'), false);
      assert.equal(JSON.stringify(invite).includes('tokenHash'), false);
    }
    const ownerAllInvites = await requestAs(owner.id, path);
    assert.equal(ownerAllInvites.status, 200);
    assert.equal(ownerAllInvites.body.data.length, 2);
    assert.deepEqual(ownerAllInvites.body.data.map((invite: { role: string }) => invite.role).sort(), ['admin', 'member']);
    assert.equal((await requestAs(member.id, path)).status, 403);
    assert.equal((await requestAs(outsider.id, path)).status, 404);
    assert.equal((await requestAs(owner.id, `${path}?limit=101`)).status, 400);

    // Recover only the safe ID from the authorized list, then revoke and reissue.
    const recovered = exactEmailList.body.data[0] as { id: string; email: string } | undefined;
    assert.ok(recovered);
    assert.equal((await requestAs(admin.id, `${path}/${recovered.id}`, 'DELETE')).status, 204);
    const replacement = await requestAs(admin.id, path, 'POST', { email: recovered.email, role: 'member' });
    assert.equal(replacement.status, 201);
    assert.notEqual(replacement.body.data.id, recovered.id);
  } finally { await cleanup(workspaces, users); }
});

test('parallel normalized-email invitations serialize to one pending row and allow reissue after expiry', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const owner = await createUser(); users.push(owner.id);
    const workspaceId = await createWorkspace(owner.id); workspaces.push(workspaceId);
    const normalizedEmail = `same-${randomUUID()}@example.test`;
    const path = `/api/v1/workspaces/${workspaceId}/invitations`;
    const results = await Promise.all([
      requestAs(owner.id, path, 'POST', { email: normalizedEmail.toUpperCase(), role: 'member' }),
      requestAs(owner.id, path, 'POST', { email: ` ${normalizedEmail} `, role: 'member' })
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    const firstInvite = results.find((result) => result.status === 201)!.body.data as { id: string };
    await pool.query("UPDATE invitations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [firstInvite.id]);
    const fresh = await requestAs(owner.id, path, 'POST', { email: normalizedEmail, role: 'member' });
    assert.equal(fresh.status, 201);
    const rows = await pool.query(
      `SELECT count(*)::int AS count FROM invitations
       WHERE workspace_id = $1 AND lower(btrim(email)) = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [workspaceId, normalizedEmail],
    );
    assert.equal(rows.rows[0]?.count, 1);
    const old = await pool.query('SELECT revoked_at FROM invitations WHERE id = $1', [firstInvite.id]);
    assert.ok(old.rows[0]?.revoked_at);
  } finally { await cleanup(workspaces, users); }
});

test('redeem and revoke serialize to exactly one terminal invitation state', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const owner = await createUser(); users.push(owner.id);
    const recipient = await createUser(); users.push(recipient.id);
    const workspaceId = await createWorkspace(owner.id); workspaces.push(workspaceId);
    const issued = await requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations`, 'POST', { email: recipient.email, role: 'member' });
    const invitationId = issued.body.data.id as string;
    const [revoke, redeem] = await Promise.all([
      requestAs(owner.id, `/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`, 'DELETE'),
      requestAs(recipient.id, '/api/v1/invitations/redeem', 'POST', { token: issued.body.data.token })
    ]);
    const terminal = await pool.query('SELECT redeemed_at, revoked_at FROM invitations WHERE id = $1', [invitationId]);
    const state = terminal.rows[0] as { redeemed_at: Date | null; revoked_at: Date | null };
    assert.notEqual(Boolean(state.redeemed_at), Boolean(state.revoked_at));
    assert.ok((revoke.status === 204 && redeem.status === 404) || (redeem.status === 200 && revoke.status === 409));
  } finally { await cleanup(workspaces, users); }
});

test('invitation administration does not accept malformed workspace or invitation IDs', async () => {
  const user = await createUser();
  try {
    assert.equal((await requestAs(user.id, '/api/v1/workspaces/not-a-uuid/invitations', 'POST', { email: 'person@example.test', role: 'member' })).status, 400);
    assert.equal((await requestAs(user.id, `/api/v1/workspaces/${randomUUID()}/invitations/not-a-uuid`, 'DELETE')).status, 400);
  } finally { await cleanup([], [user.id]); }
});
