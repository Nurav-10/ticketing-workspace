import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { LabelDomainError } from '../src/labels/label-domain.js';
import { PrismaLabelRepository } from '../src/labels/prisma-label-repository.js';
import { LabelApplicationService } from '../src/labels/label-service.js';
import { pool, prisma } from './test-database.js';

test('label CRUD enforces team visibility, management roles, uniqueness and versions', async () => {
  const workspaceId = randomUUID();
  const publicTeam = randomUUID();
  const privateTeam = randomUUID();
  const owner = randomUUID();
  const member = randomUUID();
  const outsider = randomUUID();
  const principal = (userId: string) => ({ userId, sessionId: 'label-integration' });
  const service = new LabelApplicationService(new PrismaLabelRepository(prisma));
  const expectCode = async (promise: Promise<unknown>, code: LabelDomainError['code']) =>
    assert.rejects(promise, (error: unknown) => error instanceof LabelDomainError && error.code === code);

  try {
    for (const user of [owner, member, outsider]) {
      await pool.query('INSERT INTO users(id, email, display_name) VALUES ($1, $2, $3)', [user, `${user}@example.test`, 'Label test']);
    }
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [workspaceId, 'Labels', `labels-${workspaceId}`]);
      await setup.query("INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [workspaceId, owner, member]);
      await setup.query("INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES ($1, $3, 'Public', 'PUB', 'workspace'), ($2, $3, 'Private', 'PRV', 'private')", [publicTeam, privateTeam, workspaceId]);
      await setup.query('INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)', [workspaceId, privateTeam, owner]);
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally {
      setup.release();
    }

    const publicScope = { workspaceId, teamId: publicTeam };
    const privateScope = { workspaceId, teamId: privateTeam };
    const label = await service.createForPrincipal(principal(owner), { ...publicScope, name: 'Bug' });
    await service.createForPrincipal(principal(owner), { ...privateScope, name: 'Secret' });
    await expectCode(service.createForPrincipal(principal(member), { ...publicScope, name: 'Denied' }), 'label_forbidden');
    await expectCode(service.createForPrincipal(principal(outsider), { ...publicScope, name: 'Denied' }), 'label_forbidden');
    await expectCode(service.createForPrincipal(principal(owner), { ...publicScope, name: 'BUG' }), 'label_name_conflict');
    assert.deepEqual((await service.listForPrincipal(principal(member), publicScope)).items.map((row) => row.id), [label.id]);
    assert.equal((await service.listForPrincipal(principal(member), privateScope)).items.length, 0);
    assert.equal((await service.listForPrincipal(principal(outsider), publicScope)).items.length, 0);
    const updated = await service.updateForPrincipal(principal(owner), { ...publicScope, labelId: label.id, expectedVersion: 1, name: 'Defect' });
    assert.equal(updated.version, 2);
    await expectCode(service.deleteForPrincipal(principal(owner), { ...publicScope, labelId: label.id, expectedVersion: 1 }), 'label_version_conflict');
    await service.deleteForPrincipal(principal(owner), { ...publicScope, labelId: label.id, expectedVersion: 2 });
    assert.equal((await service.listForPrincipal(principal(owner), publicScope)).items.length, 0);
  } finally {
    await pool.query('DELETE FROM labels WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[owner, member, outsider]]);
    await prisma.$disconnect();
    await pool.end();
  }
});
