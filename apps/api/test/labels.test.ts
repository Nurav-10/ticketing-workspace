import assert from 'node:assert/strict';
import test from 'node:test';
import { LabelApplicationService } from '../src/labels/label-service.js';
import { LabelDomainError } from '../src/labels/label-domain.js';

const actor = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: 'session' };
const scope = { workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', teamId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };

function serviceWith(calls: unknown[]) {
  return new LabelApplicationService({
    listAuthorized: async (query) => { calls.push(query); return []; },
    createAuthorized: async (command) => { calls.push(command); return command as never; },
    updateAuthorized: async (command) => { calls.push(command); return command as never; },
    deleteAuthorized: async (command) => { calls.push(command); },
  });
}

test('label service normalizes create values and scopes cursors to principal and team', async () => {
  const calls: unknown[] = [];
  const service = serviceWith(calls);
  await service.createForPrincipal(actor, { ...scope, name: '  Needs Review  ', color: '#AABBCC' });
  assert.deepEqual(calls[0], { ...scope, actorUserId: actor.userId, name: 'Needs Review', normalizedName: 'needs review', color: '#aabbcc' });
  const page = await service.listForPrincipal(actor, { ...scope, limit: 1 });
  assert.deepEqual(page, { items: [], nextCursor: null });
  assert.equal((calls[1] as { limit: number }).limit, 1);
});

test('label service rejects unknown fields, invalid names and unbounded page sizes', async () => {
  const service = serviceWith([]);
  await assert.rejects(service.createForPrincipal(actor, { ...scope, name: 'valid', workspaceRole: 'admin' } as never),
    (error: unknown) => error instanceof LabelDomainError && error.code === 'invalid_label_input');
  await assert.rejects(service.createForPrincipal(actor, { ...scope, name: 'x'.repeat(51) }),
    (error: unknown) => error instanceof LabelDomainError && error.code === 'invalid_label_input');
  await assert.rejects(service.listForPrincipal(actor, { ...scope, limit: 101 }),
    (error: unknown) => error instanceof LabelDomainError && error.code === 'invalid_label_input');
});

test('label update requires at least one valid mutable field and a positive expected version', async () => {
  const service = serviceWith([]);
  await assert.rejects(service.updateForPrincipal(actor, { ...scope, labelId: actor.userId, expectedVersion: 1 }),
    (error: unknown) => error instanceof LabelDomainError && error.code === 'invalid_label_input');
  await assert.rejects(service.updateForPrincipal(actor, { ...scope, labelId: actor.userId, expectedVersion: 0, color: '#ffffff' }),
    (error: unknown) => error instanceof LabelDomainError && error.code === 'invalid_label_input');
});
