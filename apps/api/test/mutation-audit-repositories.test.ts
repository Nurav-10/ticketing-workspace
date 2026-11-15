import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaInvitationRepository } from '../src/invitations/prisma-invitation-repository.js';
import { PrismaTeamRepository } from '../src/teams/prisma-team-repository.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const targetId = '33333333-3333-4333-8333-333333333333';
const invitationId = '44444444-4444-4444-8444-444444444444';
const teamId = '55555555-5555-4555-8555-555555555555';

function transactionClient(auditRows: unknown[], redeem = false) {
  return {
    auditRows,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM workspaces')) return [{ id: workspaceId }];
      if (sql.includes('FROM workspace_memberships') && sql.includes('user_id')) return [{ userId: actorId }];
      if (sql.includes('FROM users AS u') && sql.includes('workspace_memberships')) return [{ role: 'owner' }];
      if (sql.includes('FROM users AS u') && sql.includes('LEFT JOIN workspace_memberships')) return [];
      if (sql.includes('FROM invitations AS i')) return redeem ? [{
        id: invitationId, workspace_id: workspaceId, role: 'member', email: 'secret@example.test',
        redeemed_at: null, revoked_at: null, expires_at: new Date('2026-11-21T00:00:00Z'),
        user_email: 'secret@example.test', email_verified_at: new Date('2026-11-13T00:00:00Z'), user_status: 'active'
      }] : [];
      if (sql.includes('FROM invitations')) return redeem ? [{ workspace_id: workspaceId }] : [];
      if (sql.includes('clock_timestamp() AS now')) return [{ now: new Date('2026-11-14T00:00:00Z') }];
      throw new Error(`Unexpected query in test stub: ${sql}`);
    },
    $executeRaw: async () => 1,
    securityAuditEvent: {
      create: async (args: { data: { eventKind: unknown; metadata: unknown } }) => {
        auditRows.push({ eventKind: args.data.eventKind, metadata: args.data.metadata });
        return { id: '66666666-6666-4666-8666-666666666666' };
      }
    },
    invitation: {
      create: async () => ({ id: invitationId, email: 'secret@example.test', role: 'member', expiresAt: new Date('2026-11-21T00:00:00Z') }),
      updateMany: async () => ({ count: 0 })
    },
    team: {
      create: async () => ({ id: teamId, name: 'Core', key: 'CORE', visibility: 'private' })
    },
    teamMembership: { create: async () => undefined, deleteMany: async () => ({ count: 1 }) },
    workspaceMembership: { create: async () => undefined }
  };
}

function prismaWithTransaction(tx: ReturnType<typeof transactionClient>): PrismaClient {
  return {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
  } as unknown as PrismaClient;
}

test('invitation issuance records only its identifier in the same transaction', async () => {
  const tx = transactionClient([]);
  const repository = new PrismaInvitationRepository(prismaWithTransaction(tx));
  const result = await repository.issue({
    workspaceId, actorUserId: actorId, email: 'secret@example.test', role: 'member', tokenHash: Buffer.alloc(32, 7)
  });

  assert.equal(result.id, invitationId);
  assert.deepEqual(tx.auditRows, [{ eventKind: 'workspace_invitation_created', metadata: { invitation_id: invitationId } }]);
  assert.equal(JSON.stringify(tx.auditRows).includes('secret@example.test'), false);
});

test('team creation records a team-created audit event inside its transaction', async () => {
  const tx = transactionClient([]);
  const repository = new PrismaTeamRepository(prismaWithTransaction(tx));
  const result = await repository.createForAdministrator({
    workspaceId, actorUserId: actorId, name: 'Core', key: 'CORE', visibility: 'private'
  });

  assert.equal(result.id, teamId);
  assert.equal(result.visibility, 'private');
  assert.deepEqual(tx.auditRows, [{ eventKind: 'team_created', metadata: { team_id: teamId } }]);
});

test('invitation redemption records membership addition and redemption without email metadata', async () => {
  const tx = transactionClient([], true);
  const repository = new PrismaInvitationRepository(prismaWithTransaction(tx));
  const result = await repository.redeem({ userId: actorId, tokenHash: Buffer.alloc(32, 9) });

  assert.deepEqual(result, { workspaceId, role: 'member' });
  assert.deepEqual(tx.auditRows, [
    { eventKind: 'workspace_membership_added', metadata: { target_user_id: actorId, role_after: 'member' } },
    { eventKind: 'workspace_invitation_redeemed', metadata: { invitation_id: invitationId } }
  ]);
  assert.equal(JSON.stringify(tx.auditRows).includes('secret@example.test'), false);
});
