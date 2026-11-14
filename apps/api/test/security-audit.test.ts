import test from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '../src/generated/prisma/client.js';
import {
  SecurityAuditWriteError,
  writeSecurityAuditEvent,
  type SecurityAuditEventInput,
} from '../src/audit/security-audit-writer.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';
const targetUserId = '33333333-3333-4333-8333-333333333333';

function fakeTransaction(actorIsMember = true) {
  const statements: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      statements.push(sql);
      if (sql.includes('FROM workspaces')) return [{ id: workspaceId }];
      if (sql.includes('FROM workspace_memberships')) return actorIsMember ? [{ user_id: actorUserId }] : [];
      if (sql.includes('INSERT INTO security_audit_events')) return [{ id: '44444444-4444-4444-8444-444444444444' }];
      throw new Error('Unexpected statement');
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, statements };
}

const validInput: SecurityAuditEventInput = {
  workspaceId,
  actorUserId,
  eventKind: 'workspace_membership_removed',
  metadata: { target_user_id: targetUserId, role_before: 'member' },
};

test('writer validates actor scope and inserts the event through the supplied transaction', async () => {
  const { tx, statements } = fakeTransaction();
  const id = await writeSecurityAuditEvent(tx, validInput);
  assert.equal(id, '44444444-4444-4444-8444-444444444444');
  assert.equal(statements.length, 3);
  assert.match(statements[0] ?? '', /FROM workspaces[\s\S]*FOR KEY SHARE/);
  assert.match(statements[1] ?? '', /FROM workspace_memberships[\s\S]*FOR KEY SHARE/);
  assert.match(statements[2] ?? '', /INSERT INTO security_audit_events/);
});

test('writer rejects malformed or sensitive metadata before any persistence query', async () => {
  const invalidInputs: unknown[] = [
    { ...validInput, metadata: { target_user_id: targetUserId, role_before: 'member', email: 'person@example.test' } },
    { ...validInput, metadata: { target_user_id: targetUserId, token: 'secret' } },
    { ...validInput, metadata: { target_user_id: targetUserId, issue_text: 'private text' } },
    { ...validInput, metadata: { target_user_id: 'not-a-uuid', role_before: 'member' } },
    { ...validInput, metadata: { target_user_id: targetUserId, role_before: 'member', role_after: 'member' } },
    { ...validInput, eventKind: 'unreviewed_event' },
  ];
  for (const candidate of invalidInputs) {
    const { tx, statements } = fakeTransaction();
    await assert.rejects(writeSecurityAuditEvent(tx, candidate as SecurityAuditEventInput), SecurityAuditWriteError);
    assert.equal(statements.length, 0);
  }
});

test('writer requires a current same-workspace actor and does not insert for an absent membership', async () => {
  const { tx, statements } = fakeTransaction(false);
  await assert.rejects(writeSecurityAuditEvent(tx, validInput), SecurityAuditWriteError);
  assert.equal(statements.length, 2);
});

test('system events may omit an actor but still require a valid event payload and workspace', async () => {
  const { tx, statements } = fakeTransaction();
  const event: SecurityAuditEventInput = {
    workspaceId,
    actorUserId: null,
    eventKind: 'team_created',
    metadata: { team_id: targetUserId },
  };
  await writeSecurityAuditEvent(tx, event);
  assert.equal(statements.length, 2);
  assert.doesNotMatch(statements.join('\n'), /FROM workspace_memberships/);
});
