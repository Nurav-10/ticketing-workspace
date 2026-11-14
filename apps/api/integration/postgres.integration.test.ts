import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InvitationService } from '../src/invitations/invitation-service.js';
import { PostgresInvitationRepository } from '../src/invitations/postgres-invitation-repository.js';
import { ApiError } from '../src/shared/api-error.js';
import { createInvitationSecret } from '../src/invitations/invitation-service.js';
import { pool } from './test-database.js';

const invitationService = new InvitationService(new PostgresInvitationRepository(pool));

async function createUser(email: string, verified = true): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, provider_subject, email, email_verified_at, display_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `integration:${id}`, email, verified ? new Date() : null, 'Integration user']
  );
  return id;
}

async function createWorkspace(ownerId: string): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `it-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await pool.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [id, 'Integration workspace', slug]);
  await pool.query('INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)', [id, ownerId, 'owner']);
  return { id, slug };
}

async function createInvitation(workspaceId: string, inviterId: string, email: string, options: { expires?: string; revoked?: boolean } = {}) {
  const secret = createInvitationSecret();
  const id = randomUUID();
  await pool.query(
    `INSERT INTO invitations(id, workspace_id, email, role, token_hash, invited_by, expires_at, revoked_at)
     VALUES ($1, $2, $3, 'member', $4, $5, COALESCE($6::timestamptz, now() + interval '1 day'), $7)`,
    [id, workspaceId, email, secret.tokenHash, inviterId, options.expires ?? null, options.revoked ? new Date() : null]
  );
  return { id, ...secret };
}

async function cleanup(workspaceIds: string[], userIds: string[]): Promise<void> {
  if (workspaceIds.length) {
    await pool.query('DELETE FROM invitations WHERE workspace_id = ANY($1::uuid[]) OR invited_by = ANY($2::uuid[])', [workspaceIds, userIds]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
  } else if (userIds.length) {
    await pool.query('DELETE FROM invitations WHERE invited_by = ANY($1::uuid[])', [userIds]);
  }
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

test('migrations enforce workspace-local team membership foreign keys', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const userA = await createUser(`owner-a-${randomUUID()}@example.test`); users.push(userA);
    const userB = await createUser(`owner-b-${randomUUID()}@example.test`); users.push(userB);
    const workspaceA = await createWorkspace(userA); workspaces.push(workspaceA.id);
    const workspaceB = await createWorkspace(userB); workspaces.push(workspaceB.id);
    const teamA = randomUUID();
    const teamB = randomUUID();
    await pool.query('INSERT INTO teams(id, workspace_id, name, key) VALUES ($1, $2, $3, $4)', [teamA, workspaceA.id, 'Team A', `A${randomUUID().slice(0, 4).toUpperCase()}`]);
    await pool.query('INSERT INTO teams(id, workspace_id, name, key) VALUES ($1, $2, $3, $4)', [teamB, workspaceB.id, 'Team B', `B${randomUUID().slice(0, 4).toUpperCase()}`]);
    await pool.query('INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)', [workspaceB.id, teamA, userB]).then(
      () => assert.fail('cross-workspace team relation unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23503')
    );
    await pool.query('INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)', [workspaceB.id, teamB, userA]).then(
      () => assert.fail('cross-workspace user membership unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23503')
    );
  } finally { await cleanup(workspaces, users); }
});

test('verified invited email redeems atomically and token replay is denied', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const inviterId = await createUser(`inviter-${randomUUID()}@example.test`); users.push(inviterId);
    const recipientEmail = `recipient-${randomUUID()}@example.test`;
    const recipientId = await createUser(recipientEmail.toUpperCase()); users.push(recipientId);
    const workspace = await createWorkspace(inviterId); workspaces.push(workspace.id);
    const invitation = await createInvitation(workspace.id, inviterId, ` ${recipientEmail} `);

    const result = await invitationService.redeem({ userId: recipientId, sessionId: 'verified-session' }, invitation.token);
    assert.deepEqual(result, { workspaceId: workspace.id, role: 'member' });
    const membership = await pool.query('SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [workspace.id, recipientId]);
    assert.deepEqual(membership.rows, [{ role: 'member' }]);
    const consumed = await pool.query('SELECT redeemed_at FROM invitations WHERE id = $1', [invitation.id]);
    assert.ok(consumed.rows[0]?.redeemed_at);
    await assert.rejects(
      () => invitationService.redeem({ userId: recipientId, sessionId: 'verified-session' }, invitation.token),
      (error: unknown) => error instanceof ApiError && error.statusCode === 404
    );
  } finally { await cleanup(workspaces, users); }
});

test('email mismatch and unverified addresses cannot redeem invitations', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const inviterId = await createUser(`inviter-${randomUUID()}@example.test`); users.push(inviterId);
    const matchingEmail = `pending-${randomUUID()}@example.test`;
    const mismatchId = await createUser(`other-${randomUUID()}@example.test`); users.push(mismatchId);
    const unverifiedId = await createUser(matchingEmail, false); users.push(unverifiedId);
    const workspace = await createWorkspace(inviterId); workspaces.push(workspace.id);
    const forMismatch = await createInvitation(workspace.id, inviterId, `invitee-${randomUUID()}@example.test`);
    const forUnverified = await createInvitation(workspace.id, inviterId, matchingEmail);

    for (const [userId, token] of [[mismatchId, forMismatch.token], [unverifiedId, forUnverified.token]] as const) {
      await assert.rejects(
        () => invitationService.redeem({ userId, sessionId: 'test-session' }, token),
        (error: unknown) => error instanceof ApiError && error.statusCode === 403
      );
    }
    const unconsumed = await pool.query('SELECT count(*)::int AS count FROM invitations WHERE id = ANY($1::uuid[]) AND redeemed_at IS NOT NULL', [[forMismatch.id, forUnverified.id]]);
    assert.equal(unconsumed.rows[0]?.count, 0);
  } finally { await cleanup(workspaces, users); }
});

test('expired and revoked invitations are unavailable', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const inviterId = await createUser(`inviter-${randomUUID()}@example.test`); users.push(inviterId);
    const recipientId = await createUser(`recipient-${randomUUID()}@example.test`); users.push(recipientId);
    const workspace = await createWorkspace(inviterId); workspaces.push(workspace.id);
    const expired = await createInvitation(workspace.id, inviterId, `recipient-${randomUUID()}@example.test`);
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    const revoked = await createInvitation(workspace.id, inviterId, `recipient-${randomUUID()}@example.test`, { revoked: true });

    for (const token of [expired.token, revoked.token]) {
      await assert.rejects(
        () => invitationService.redeem({ userId: recipientId, sessionId: 'test-session' }, token),
        (error: unknown) => error instanceof ApiError && error.statusCode === 404
      );
    }
    const unconsumed = await pool.query('SELECT count(*)::int AS count FROM invitations WHERE id = ANY($1::uuid[]) AND redeemed_at IS NOT NULL', [[expired.id, revoked.id]]);
    assert.equal(unconsumed.rows[0]?.count, 0);
  } finally { await cleanup(workspaces, users); }
});

test('simultaneous redemption through separate database connections has one winner', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const inviterId = await createUser(`inviter-${randomUUID()}@example.test`); users.push(inviterId);
    const recipientId = await createUser(`recipient-${randomUUID()}@example.test`); users.push(recipientId);
    const workspace = await createWorkspace(inviterId); workspaces.push(workspace.id);
    const invitation = await createInvitation(workspace.id, inviterId, (await pool.query('SELECT email FROM users WHERE id = $1', [recipientId])).rows[0].email);

    const outcomes = await Promise.allSettled([
      invitationService.redeem({ userId: recipientId, sessionId: 'session-a' }, invitation.token),
      invitationService.redeem({ userId: recipientId, sessionId: 'session-b' }, invitation.token)
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
    const membership = await pool.query('SELECT count(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [workspace.id, recipientId]);
    assert.equal(membership.rows[0]?.count, 1);
  } finally { await cleanup(workspaces, users); }
});

test('unique workspace membership and owner constraints are enforced', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const ownerId = await createUser(`owner-${randomUUID()}@example.test`); users.push(ownerId);
    const secondUserId = await createUser(`second-${randomUUID()}@example.test`); users.push(secondUserId);
    const workspace = await createWorkspace(ownerId); workspaces.push(workspace.id);
    await pool.query('INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspace.id, ownerId, 'member']).then(
      () => assert.fail('duplicate workspace membership unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23505')
    );
    await pool.query('INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspace.id, secondUserId, 'owner']).then(
      () => assert.fail('second workspace owner unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23505')
    );
  } finally { await cleanup(workspaces, users); }
});

test.after(async () => { await pool.end(); });
