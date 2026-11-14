import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeSecurityAuditEvent } from '../src/audit/security-audit-writer.js';
import { pool, prisma, removeTestAuditEvents } from './test-database.js';

test('audit rows use database time, survive self-leave, and resist mutation and workspace deletion', async () => {
  const unique = randomBytes(8).toString('hex');
  const fixture = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.create({
      data: { email: `audit-owner-${unique}@example.test`, displayName: 'Audit Owner', status: 'active' },
      select: { id: true },
    });
    const actor = await tx.user.create({
      data: { email: `audit-actor-${unique}@example.test`, displayName: 'Audit Actor', status: 'active' },
      select: { id: true },
    });
    const workspace = await tx.workspace.create({
      data: { name: 'Audit Fixture', slug: `audit-${unique}` },
      select: { id: true },
    });
    await tx.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    await tx.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: actor.id, role: 'member' } });

    const eventId = await writeSecurityAuditEvent(tx, {
      workspaceId: workspace.id,
      actorUserId: actor.id,
      eventKind: 'workspace_membership_removed',
      metadata: { target_user_id: actor.id, role_before: 'member' },
    });
    await tx.workspaceMembership.delete({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: actor.id } } });
    return { eventId, workspaceId: workspace.id, actorUserId: actor.id, ownerUserId: owner.id };
  });

  const persisted = await pool.query<{
    workspace_id: string;
    actor_user_id: string;
    event_kind: string;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(`SELECT workspace_id::text, actor_user_id::text, event_kind::text, metadata, created_at
      FROM security_audit_events WHERE id = $1::uuid`, [fixture.eventId]);
  assert.equal(persisted.rows.length, 1);
  assert.equal(persisted.rows[0]?.workspace_id, fixture.workspaceId);
  assert.equal(persisted.rows[0]?.actor_user_id, fixture.actorUserId);
  assert.equal(persisted.rows[0]?.event_kind, 'workspace_membership_removed');
  assert.deepEqual(persisted.rows[0]?.metadata, { target_user_id: fixture.actorUserId, role_before: 'member' });
  assert.ok(persisted.rows[0]?.created_at instanceof Date);

  const membership = await pool.query(
    `SELECT 1 FROM workspace_memberships WHERE workspace_id = $1::uuid AND user_id = $2::uuid`,
    [fixture.workspaceId, fixture.actorUserId],
  );
  assert.equal(membership.rows.length, 0, 'self-leave should commit while the immutable audit reference remains');

  const mutationSql = [
    ['UPDATE security_audit_events SET metadata = \'{}\'::jsonb WHERE id = $1::uuid', [fixture.eventId]],
    ['DELETE FROM security_audit_events WHERE id = $1::uuid', [fixture.eventId]],
    ['TRUNCATE security_audit_events', []],
  ] as const;
  for (const [sql, values] of mutationSql) {
    const client = await pool.connect();
    let failure: { code?: string } | undefined;
    try {
      await client.query('BEGIN');
      try { await client.query(sql, [...values]); }
      catch (error) { failure = error as { code?: string }; }
      await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal(failure?.code, '55000', `append-only guard should reject: ${sql}`);
  }

  const invalidMetadata = await pool.query(
    `INSERT INTO security_audit_events(workspace_id, actor_user_id, event_kind, metadata)
     VALUES ($1::uuid, $2::uuid, 'team_created'::security_audit_event_kind, $3::jsonb)`,
    [fixture.workspaceId, fixture.ownerUserId, JSON.stringify({ team_id: '55555555-5555-4555-8555-555555555555', email: 'private@example.test' })],
  ).then(() => undefined, (error: { code?: string }) => error);
  assert.equal((invalidMetadata as { code?: string } | undefined)?.code, '23514');

  const nullMetadataField = await pool.query(
    `INSERT INTO security_audit_events(workspace_id, actor_user_id, event_kind, metadata)
     VALUES ($1::uuid, $2::uuid, 'team_created'::security_audit_event_kind, $3::jsonb)`,
    [fixture.workspaceId, fixture.ownerUserId, JSON.stringify({ team_id: null })],
  ).then(() => undefined, (error: { code?: string }) => error);
  assert.equal((nullMetadataField as { code?: string } | undefined)?.code, '23514');

  const removedActorInsert = await pool.query(
    `INSERT INTO security_audit_events(workspace_id, actor_user_id, event_kind, metadata)
     VALUES ($1::uuid, $2::uuid, 'team_created'::security_audit_event_kind, $3::jsonb)`,
    [fixture.workspaceId, fixture.actorUserId, JSON.stringify({ team_id: '55555555-5555-4555-8555-555555555555' })],
  ).then(() => undefined, (error: { code?: string }) => error);
  assert.equal((removedActorInsert as { code?: string } | undefined)?.code, '23514');

  const forgedTime = await pool.query<{ created_at: Date }>(
    `INSERT INTO security_audit_events(workspace_id, actor_user_id, event_kind, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, 'team_created'::security_audit_event_kind, $3::jsonb, '1900-01-01T00:00:00Z')
     RETURNING created_at`,
    [fixture.workspaceId, fixture.ownerUserId, JSON.stringify({ team_id: '55555555-5555-4555-8555-555555555555' })],
  );
  assert.ok(forgedTime.rows[0]?.created_at.getTime() > Date.now() - 60_000);

  const actorDelete = await pool.query('DELETE FROM users WHERE id = $1::uuid', [fixture.actorUserId])
    .then(() => undefined, (error: { code?: string }) => error);
  assert.equal((actorDelete as { code?: string } | undefined)?.code, '23503');
  const actorStillPresent = await pool.query('SELECT 1 FROM users WHERE id = $1::uuid', [fixture.actorUserId]);
  assert.equal(actorStillPresent.rows.length, 1);

  const workspaceDelete = await pool.query('DELETE FROM workspaces WHERE id = $1::uuid', [fixture.workspaceId])
    .then(() => undefined, (error: { code?: string }) => error);
  assert.equal((workspaceDelete as { code?: string } | undefined)?.code, '23503');
  const stillPresent = await pool.query('SELECT 1 FROM workspaces WHERE id = $1::uuid', [fixture.workspaceId]);
  assert.equal(stillPresent.rows.length, 1);

  await removeTestAuditEvents([fixture.workspaceId]);
  await pool.query('DELETE FROM workspaces WHERE id = $1::uuid', [fixture.workspaceId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[fixture.actorUserId, fixture.ownerUserId]]);
});
