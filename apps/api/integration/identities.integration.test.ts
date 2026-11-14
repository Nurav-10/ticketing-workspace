import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { IdentityService } from '../src/identity-persistence/identity-service.js';
import type { ValidatedProviderIdentity } from '../src/identity-persistence/identity-repository.js';
import { PrismaIdentityRepository } from '../src/identity-persistence/prisma-identity-repository.js';
import { pool, prisma, removeTestAuditEvents } from './test-database.js';

const identityService = new IdentityService(new PrismaIdentityRepository(prisma));

function providerIdentity(input: Partial<ValidatedProviderIdentity> & Pick<ValidatedProviderIdentity, 'issuer' | 'subject'>): ValidatedProviderIdentity {
  return {
    email: input.email ?? null,
    emailVerified: input.emailVerified ?? false,
    displayName: input.displayName ?? null,
    ...input,
  };
}

async function createLegacyUser(email = `legacy-${randomUUID()}@example.test`): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, provider_subject, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, `legacy-subject:${id}`, email, 'Legacy identity user'],
  );
  return id;
}

async function createWorkspace(ownerId: string): Promise<string> {
  const id = randomUUID();
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [
      id,
      'Identity integration workspace',
      `id-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    ]);
    await setup.query(
      'INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [id, ownerId, 'owner'],
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally { setup.release(); }
  return id;
}

async function createInvitation(workspaceId: string, inviterId: string, email: string): Promise<{ id: string; tokenHash: Buffer }> {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token, 'ascii').digest();
  await pool.query(
    `INSERT INTO invitations(id, workspace_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, 'member', $4, $5, clock_timestamp() + interval '1 hour')`,
    [id, workspaceId, email, tokenHash, inviterId],
  );
  return { id, tokenHash };
}

async function cleanup(workspaceIds: string[], userIds: string[]): Promise<void> {
  await removeTestAuditEvents(workspaceIds);
  if (workspaceIds.length || userIds.length) {
    await pool.query(
      'DELETE FROM invitations WHERE workspace_id = ANY($1::uuid[]) OR invited_by = ANY($2::uuid[])',
      [workspaceIds, userIds],
    );
  }
  if (workspaceIds.length) await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

test('preserves legacy provider subjects without assigning issuers or linking by email', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const sharedEmail = `same-${randomUUID()}@example.test`;
    const legacyUserId = await createLegacyUser(sharedEmail); users.push(legacyUserId);
    const legacyBefore = await pool.query('SELECT provider_subject FROM users WHERE id = $1', [legacyUserId]);
    const claims = providerIdentity({ issuer: 'https://issuer.example/', subject: 'Subject-1', email: sharedEmail, emailVerified: true });

    assert.deepEqual(await identityService.resolve(claims), { kind: 'provisioning_required' });
    const unapproved = await pool.query(
      `SELECT count(*)::int AS count FROM user_identities WHERE issuer = $1 AND subject = $2`,
      [claims.issuer, claims.subject],
    );
    assert.equal(unapproved.rows[0]?.count, 0);

    const workspace = await createWorkspace(legacyUserId); workspaces.push(workspace);
    const invitation = await createInvitation(workspace, legacyUserId, sharedEmail);
    const created = await identityService.provisionFromInvitation(claims, { kind: 'invitation', tokenHash: invitation.tokenHash });
    assert.equal(created.kind, 'resolved');
    if (created.kind !== 'resolved') return;
    users.push(created.userId);
    assert.notEqual(created.userId, legacyUserId, 'matching email never links the new subject to a legacy user');

    const legacyAfter = await pool.query('SELECT provider_subject FROM users WHERE id = $1', [legacyUserId]);
    assert.equal(legacyAfter.rows[0]?.provider_subject, legacyBefore.rows[0]?.provider_subject);
    const newUser = await pool.query('SELECT provider_subject, email_verified_at FROM users WHERE id = $1', [created.userId]);
    assert.equal(newUser.rows[0]?.provider_subject, null);
    assert.ok(newUser.rows[0]?.email_verified_at);

    assert.deepEqual(await identityService.resolve(claims), created);
  } finally {
    await cleanup(workspaces, users);
  }
});

test('new identity creation requires a validated verified email and a live invitation grant', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const inviterId = await createLegacyUser(); users.push(inviterId);
    const workspace = await createWorkspace(inviterId); workspaces.push(workspace);
    const email = `invitee-${randomUUID()}@example.test`;
    const invitation = await createInvitation(workspace, inviterId, email);
    const unverified = providerIdentity({ issuer: 'https://issuer.example/', subject: 'unverified', email, emailVerified: false });

    assert.deepEqual(await identityService.resolve(unverified), { kind: 'provisioning_required' });
    assert.deepEqual(
      await identityService.provisionFromInvitation(unverified, { kind: 'invitation', tokenHash: invitation.tokenHash }),
      { kind: 'invitation_unavailable' },
    );
    const state = await pool.query('SELECT redeemed_at FROM invitations WHERE id = $1', [invitation.id]);
    assert.equal(state.rows[0]?.redeemed_at, null);

    const invalidIssuer = providerIdentity({ issuer: 'http://issuer.example/', subject: 'http', email, emailVerified: true });
    await assert.rejects(() => identityService.resolve(invalidIssuer), /Invalid validated provider identity/);
    const emptySubject = providerIdentity({ issuer: 'https://issuer.example/', subject: '', email, emailVerified: true });
    await assert.rejects(() => identityService.resolve(emptySubject), /Invalid validated provider identity/);
    const invalidGrant = await identityService.provisionFromInvitation(
      providerIdentity({ issuer: 'https://issuer.example/', subject: 'invalid-grant', email, emailVerified: true }),
      { kind: 'invitation', tokenHash: Buffer.alloc(31) },
    );
    assert.deepEqual(invalidGrant, { kind: 'invitation_unavailable' });
    const unknownTokenHash = await identityService.provisionFromInvitation(
      providerIdentity({ issuer: 'https://issuer.example/', subject: 'unknown-grant', email, emailVerified: true }),
      { kind: 'invitation', tokenHash: Buffer.alloc(32, 0x77) },
    );
    assert.deepEqual(unknownTokenHash, { kind: 'invitation_unavailable' });
  } finally {
    await cleanup(workspaces, users);
  }
});

test('issuer and subject pair is exact; the same subject at a different issuer is a separate identity', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const inviterId = await createLegacyUser(); users.push(inviterId);
    const workspace = await createWorkspace(inviterId); workspaces.push(workspace);
    const email = `multi-issuer-${randomUUID()}@example.test`;
    const invitationA = await createInvitation(workspace, inviterId, email);
    const invitationB = await createInvitation(workspace, inviterId, email);
    const identityA = providerIdentity({ issuer: 'https://issuer-a.example/', subject: 'shared-subject', email, emailVerified: true });
    const identityB = providerIdentity({ issuer: 'https://issuer-b.example/', subject: 'shared-subject', email, emailVerified: true });

    const first = await identityService.provisionFromInvitation(identityA, { kind: 'invitation', tokenHash: invitationA.tokenHash });
    const second = await identityService.provisionFromInvitation(identityB, { kind: 'invitation', tokenHash: invitationB.tokenHash });
    assert.equal(first.kind, 'resolved');
    assert.equal(second.kind, 'resolved');
    if (first.kind !== 'resolved' || second.kind !== 'resolved') return;
    users.push(first.userId, second.userId);
    assert.notEqual(first.userId, second.userId);

    const caseSensitive = providerIdentity({ issuer: identityA.issuer, subject: 'SHARED-SUBJECT', email, emailVerified: true });
    const noCaseLink = await identityService.resolve(caseSensitive);
    assert.deepEqual(noCaseLink, { kind: 'provisioning_required' });
    const mapped = await pool.query(
      `SELECT issuer, subject, user_id::text AS user_id
       FROM user_identities WHERE subject = $1 ORDER BY issuer`,
      ['shared-subject'],
    );
    assert.deepEqual(mapped.rows, [
      { issuer: identityA.issuer, subject: identityA.subject, user_id: first.userId },
      { issuer: identityB.issuer, subject: identityB.subject, user_id: second.userId },
    ]);
  } finally {
    await cleanup(workspaces, users);
  }
});

test('concurrent first login keeps one user and requires the losing grant to be retried', async () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  try {
    const inviterId = await createLegacyUser(); users.push(inviterId);
    const workspace = await createWorkspace(inviterId); workspaces.push(workspace);
    const email = `race-${randomUUID()}@example.test`;
    const invitationA = await createInvitation(workspace, inviterId, email);
    const invitationB = await createInvitation(workspace, inviterId, email);
    const claims = providerIdentity({ issuer: 'https://issuer-race.example/', subject: `first-login-${randomUUID()}`, email, emailVerified: true });

    const outcomes = await Promise.all([
      identityService.provisionFromInvitation(claims, { kind: 'invitation', tokenHash: invitationA.tokenHash }),
      identityService.provisionFromInvitation(claims, { kind: 'invitation', tokenHash: invitationB.tokenHash }),
    ]);
    assert.equal(outcomes.filter((result) => result.kind === 'resolved').length, 1);
    assert.equal(outcomes.filter((result) => result.kind === 'retryable_conflict').length, 1);
    const created = outcomes.find((result) => result.kind === 'resolved');
    if (!created || created.kind !== 'resolved') throw new Error('Expected one provisioned identity');
    users.push(created.userId);

    const counts = await pool.query(
      `SELECT count(DISTINCT i.user_id)::int AS users,
              count(*)::int AS identities,
              count(DISTINCT m.workspace_id)::int AS memberships
       FROM user_identities AS i
       JOIN workspace_memberships AS m ON m.user_id = i.user_id
       WHERE i.issuer = $1 AND i.subject = $2`,
      [claims.issuer, claims.subject],
    );
    assert.deepEqual(counts.rows[0], { users: 1, identities: 1, memberships: 1 });
  } finally {
    await cleanup(workspaces, users);
  }
});

test('identity constraints enforce issuer/subject uniqueness, HTTPS, and user foreign key', async () => {
  const users: string[] = [];
  try {
    const userA = await createLegacyUser(); users.push(userA);
    const userB = await createLegacyUser(); users.push(userB);
    const nowResult = await pool.query('SELECT clock_timestamp() AS now');
    const now = nowResult.rows[0]?.now as Date;
    const insert = async (userId: string, issuer: string, subject: string) => pool.query(
      `INSERT INTO user_identities(user_id, issuer, subject, created_at, last_authenticated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [userId, issuer, subject, now],
    );

    await insert(userA, 'https://unique-issuer.example/', 'same-subject');
    await insert(userB, 'https://other-issuer.example/', 'same-subject');
    await insert(userB, 'https://unique-issuer.example/', 'different-subject');
    await insert(userB, 'https://unique-issuer.example/', 'SAME-SUBJECT');
    await insert(userB, 'https://unique-issuer.example/', 'same-subject').then(
      () => assert.fail('duplicate issuer/subject unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23505'),
    );
    await insert(userA, 'http://insecure-issuer.example/', 'http-subject').then(
      () => assert.fail('non-HTTPS issuer unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23514'),
    );
    await insert(userA, 'https://unique-issuer.example/', '').then(
      () => assert.fail('empty subject unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23514'),
    );
    await insert(randomUUID(), 'https://missing-user.example/', 'orphan-subject').then(
      () => assert.fail('identity for missing user unexpectedly succeeded'),
      (error: { code?: string }) => assert.equal(error.code, '23503'),
    );
  } finally {
    await cleanup([], users);
  }
});

test.after(async () => { await prisma.$disconnect(); await pool.end(); });
