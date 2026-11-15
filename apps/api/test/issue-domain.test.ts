import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IssueDomainError,
  allowedTransitionSources,
  canTransition,
  createPayloadHash,
  validateCreateIssueInput,
  validateIssuePatch,
  validateListQuery,
} from '../src/issues/issue-domain.js';
import { IssueApplicationService } from '../src/issues/issue-service.js';
import type { IssueRepository } from '../src/issues/issue-repository.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const issueId = '24fba2dd-8131-4c53-a8b4-07ab988da002';
const actorId = '49a03ed2-7eb3-4c00-a8e1-519c70306427';
const principal = { userId: actorId, sessionId: 'session-1' };

test('create validation trims title, applies defaults, and bounds text', () => {
  const input = validateCreateIssueInput({
    workspaceId, teamId, title: '  Fix search  ', idempotencyKey: 'req-1',
  });
  assert.equal(input.title, 'Fix search');
  assert.equal(input.description, null);
  assert.equal(input.priority, 'none');
  assert.equal(input.assigneeUserId, null);
  assert.throws(() => validateCreateIssueInput({ workspaceId, teamId, title: '  ', idempotencyKey: 'req-2' }), IssueDomainError);
  assert.throws(() => validateCreateIssueInput({ workspaceId, teamId, title: 'ok', description: 'x'.repeat(20_001), idempotencyKey: 'req-3' }), IssueDomainError);
});

test('create and patch validation reject NUL in text persisted as PostgreSQL varchar', () => {
  assert.throws(() => validateCreateIssueInput({ workspaceId, teamId, title: 'bad\0title', idempotencyKey: 'req-nul-title' }), IssueDomainError);
  assert.throws(() => validateCreateIssueInput({ workspaceId, teamId, title: 'valid', description: 'bad\0description', idempotencyKey: 'req-nul-description' }), IssueDomainError);
  assert.throws(() => validateIssuePatch({ workspaceId, teamId, issueId, expectedVersion: 1, title: 'bad\0title' }), IssueDomainError);
  assert.throws(() => validateIssuePatch({ workspaceId, teamId, issueId, expectedVersion: 1, description: 'bad\0description' }), IssueDomainError);
});

test('workflow has only explicit transitions and exposes safe source constraints', () => {
  assert.equal(canTransition('todo', 'in_progress'), true);
  assert.equal(canTransition('done', 'in_progress'), false);
  assert.deepEqual(allowedTransitionSources('done'), ['in_progress']);
  assert.deepEqual(allowedTransitionSources('backlog'), ['todo', 'canceled']);
});

test('create hashes use normalized payload fields and list limits are bounded', () => {
  const a = validateCreateIssueInput({ workspaceId, teamId, title: ' One ', idempotencyKey: 'same' });
  const b = validateCreateIssueInput({ workspaceId, teamId, title: 'One', priority: 'none', description: null, assigneeUserId: null, idempotencyKey: 'different' });
  assert.equal(createPayloadHash(a), createPayloadHash(b));
  assert.notEqual(createPayloadHash(a), createPayloadHash({ ...b, priority: 'high' }));
  assert.notEqual(createPayloadHash(a), createPayloadHash({ ...b, teamId: '11111111-1111-4111-8111-111111111111' }));
  assert.equal(validateListQuery({ workspaceId, teamId }).limit, 50);
  assert.equal(validateListQuery({ workspaceId, teamId, limit: 100 }).limit, 100);
  assert.throws(() => validateListQuery({ workspaceId, teamId, limit: 101 }), IssueDomainError);
});

test('patch requires a supported change and a positive expected version', () => {
  assert.throws(() => validateIssuePatch({ workspaceId, teamId, issueId, expectedVersion: 1 }), IssueDomainError);
  assert.throws(() => validateIssuePatch({ workspaceId, teamId, issueId, expectedVersion: 0, title: 'valid' }), IssueDomainError);
  const patch = validateIssuePatch({ workspaceId, teamId, issueId, expectedVersion: 7, description: null });
  assert.equal(patch.expectedVersion, 7);
  assert.deepEqual(patch.changes, { description: null });
});

test('service derives actor from principal and passes version/transition checks to the atomic port', async () => {
  let updateCommand: unknown;
  let transitionCommand: unknown;
  const repository: IssueRepository = {
    createAuthorized: async () => { throw new Error('not exercised'); },
    listAuthorized: async () => ({ items: [] }),
    getAuthorized: async () => { throw new Error('not exercised'); },
    updateAuthorized: async (command) => { updateCommand = command; throw new Error('stop after capture'); },
    transitionAuthorized: async (command) => { transitionCommand = command; throw new Error('stop after capture'); },
    setArchivedAuthorized: async () => { throw new Error('not exercised'); },
  };
  const service = new IssueApplicationService(repository);
  await assert.rejects(service.updateForPrincipal(principal, {
    workspaceId, teamId, issueId, expectedVersion: 3, title: 'Updated',
  }), /stop after capture/);
  assert.deepEqual(updateCommand, {
    workspaceId, teamId, issueId, expectedVersion: 3, changes: { title: 'Updated' }, actorUserId: actorId,
  });
  await assert.rejects(service.transitionForPrincipal(principal, {
    workspaceId, teamId, issueId, expectedVersion: 3, targetStatus: 'done',
  }), /stop after capture/);
  assert.deepEqual(transitionCommand, {
    workspaceId, teamId, issueId, expectedVersion: 3, actorUserId: actorId,
    targetStatus: 'done', allowedFromStatuses: ['in_progress'],
  });
});

test('create passes an actor-scoped command and database-clock retention to persistence', async () => {
  let captured: Parameters<IssueRepository['createAuthorized']>[0] | undefined;
  const repository: IssueRepository = {
    createAuthorized: async (command) => { captured = command; throw new Error('captured'); },
    listAuthorized: async () => ({ items: [] }),
    getAuthorized: async () => { throw new Error('not exercised'); },
    updateAuthorized: async () => { throw new Error('not exercised'); },
    transitionAuthorized: async () => { throw new Error('not exercised'); },
    setArchivedAuthorized: async () => { throw new Error('not exercised'); },
  };
  const service = new IssueApplicationService(repository);
  await assert.rejects(service.createForPrincipal(principal, { workspaceId, teamId, title: '  Example  ', idempotencyKey: 'request-1' }), /captured/);
  assert.equal(captured?.actorUserId, actorId);
  assert.equal(captured?.title, 'Example');
  assert.equal(captured?.idempotencyRetentionMs, 24 * 60 * 60 * 1_000);
  assert.match(captured?.payloadHash ?? '', /^[a-f0-9]{64}$/);
});
