import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  WorkflowDomainError,
  validateAddTransitionInput,
  validateCategory,
  validateCreateStatusInput,
  validateDeleteTransitionInput,
  validateKey,
  validateName,
  validatePosition,
  validateRetireStatusInput,
  validateUpdateStatusInput,
} from '../src/workflows/workflow-domain.js';

test('WorkflowDomain: validates status keys', () => {
  assert.equal(validateKey('in_review'), 'in_review');
  assert.equal(validateKey('In_Review'), 'in_review');
  assert.equal(validateKey('  qa-testing  '), 'qa-testing');

  assert.throws(() => validateKey(''), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
  assert.throws(() => validateKey('invalid key with spaces'), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
  assert.throws(() => validateKey('a'.repeat(65)), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
  assert.throws(() => validateKey(123), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
});

test('WorkflowDomain: validates status names', () => {
  assert.equal(validateName('In Review'), 'In Review');
  assert.equal(validateName('  Trimmed Name  '), 'Trimmed Name');

  assert.throws(() => validateName(''), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
  assert.throws(() => validateName('   '), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
  assert.throws(() => validateName('x'.repeat(101)), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
});

test('WorkflowDomain: validates categories', () => {
  assert.equal(validateCategory('backlog'), 'backlog');
  assert.equal(validateCategory('unstarted'), 'unstarted');
  assert.equal(validateCategory('started'), 'started');
  assert.equal(validateCategory('completed'), 'completed');
  assert.equal(validateCategory('canceled'), 'canceled');

  assert.throws(() => validateCategory('invalid_category'), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
});

test('WorkflowDomain: validates positions and versions', () => {
  assert.equal(validatePosition(0), 0);
  assert.equal(validatePosition(5), 5);
  assert.throws(() => validatePosition(-1), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
  assert.throws(() => validatePosition(1.5), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');

  assert.throws(() => validateCreateStatusInput({
    workspaceId: randomUUID(),
    teamId: randomUUID(),
    key: 'test',
    name: 'Test',
    category: 'started',
    expectedVersion: 0,
  }), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
});

test('WorkflowDomain: validates create status command input', () => {
  const workspaceId = randomUUID();
  const teamId = randomUUID();

  const validated = validateCreateStatusInput({
    workspaceId,
    teamId,
    key: 'TRIAGE',
    name: 'Triage Stage',
    category: 'backlog',
    position: 0,
    isDefault: true,
    expectedVersion: 1,
  });

  assert.deepEqual(validated, {
    workspaceId,
    teamId,
    key: 'triage',
    name: 'Triage Stage',
    category: 'backlog',
    position: 0,
    isDefault: true,
    expectedVersion: 1,
  });

  assert.throws(() => validateCreateStatusInput({
    workspaceId: 'bad-id',
    teamId,
    key: 'triage',
    name: 'Triage',
    category: 'backlog',
    expectedVersion: 1,
  }), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');
});

test('WorkflowDomain: validates update status command input', () => {
  const workspaceId = randomUUID();
  const teamId = randomUUID();
  const statusId = randomUUID();

  assert.throws(() => validateUpdateStatusInput({
    workspaceId,
    teamId,
    statusId,
    expectedVersion: 1,
  }), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'invalid_workflow_input');

  const validated = validateUpdateStatusInput({
    workspaceId,
    teamId,
    statusId,
    name: 'New Name',
    category: 'started',
    position: 2,
    isDefault: false,
    expectedVersion: 3,
  });

  assert.equal(validated.changes.name, 'New Name');
  assert.equal(validated.changes.category, 'started');
  assert.equal(validated.changes.position, 2);
  assert.equal(validated.changes.isDefault, false);
  assert.equal(validated.expectedVersion, 3);
});

test('WorkflowDomain: validates retire status input', () => {
  const workspaceId = randomUUID();
  const teamId = randomUUID();
  const statusId = randomUUID();
  const targetStatusId = randomUUID();

  const validated = validateRetireStatusInput({
    workspaceId,
    teamId,
    statusId,
    targetStatusId,
    expectedVersion: 2,
  });

  assert.equal(validated.statusId, statusId);
  assert.equal(validated.targetStatusId, targetStatusId);
  assert.equal(validated.expectedVersion, 2);

  // Self-reassignment is forbidden
  assert.throws(() => validateRetireStatusInput({
    workspaceId,
    teamId,
    statusId,
    targetStatusId: statusId,
    expectedVersion: 1,
  }), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_reassignment_target_invalid');
});

test('WorkflowDomain: validates transition edges', () => {
  const workspaceId = randomUUID();
  const teamId = randomUUID();
  const sourceStatusId = randomUUID();
  const targetStatusId = randomUUID();

  const validated = validateAddTransitionInput({
    workspaceId,
    teamId,
    sourceStatusId,
    targetStatusId,
    expectedVersion: 1,
  });
  assert.equal(validated.sourceStatusId, sourceStatusId);
  assert.equal(validated.targetStatusId, targetStatusId);

  // Self loop is forbidden
  assert.throws(() => validateAddTransitionInput({
    workspaceId,
    teamId,
    sourceStatusId,
    targetStatusId: sourceStatusId,
    expectedVersion: 1,
  }), (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_invalid_transition');

  const del = validateDeleteTransitionInput({
    workspaceId,
    teamId,
    sourceStatusId,
    targetStatusId,
    expectedVersion: 2,
  });
  assert.equal(del.expectedVersion, 2);
});
