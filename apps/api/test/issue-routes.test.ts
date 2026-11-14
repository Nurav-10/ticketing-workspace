import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueDomainError } from '../src/issues/issue-domain.js';
import { mapIssueError } from '../src/issues/issue-routes.js';

test('issue domain failures map to stable public HTTP error semantics', () => {
  const cases = [
    ['invalid_issue_input', 400, 'invalid_request'],
    ['issue_not_found', 404, 'not_found'],
    ['issue_forbidden', 403, 'forbidden'],
    ['issue_version_conflict', 409, 'version_conflict'],
    ['issue_invalid_transition', 409, 'invalid_transition'],
    ['issue_number_exhausted', 409, 'number_exhausted'],
    ['issue_idempotency_conflict', 409, 'idempotency_conflict'],
    ['issue_assignee_unavailable', 400, 'invalid_assignee'],
  ] as const;

  for (const [domainCode, statusCode, publicCode] of cases) {
    const mapped = mapIssueError(new IssueDomainError(domainCode, 'safe issue error'));
    assert.equal(mapped.statusCode, statusCode);
    assert.equal(mapped.code, publicCode);
    assert.equal(mapped.message, 'safe issue error');
  }
});
