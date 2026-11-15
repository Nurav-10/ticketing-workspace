import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueSearchDomainError, validateIssueSearchInput } from '../src/search/issue-search-domain.js';

const scope = { workspaceId: '8bb8e0ee-238c-4ba5-89ba-0f4e852861af', teamId: 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a' };

test('search input is bounded, normalized, and rejects unsafe or unsupported values', () => {
  assert.deepEqual(validateIssueSearchInput({ ...scope, searchTerm: '  Ocean  ' }), { ...scope, searchTerm: 'Ocean', archiveMode: 'active', limit: 25 });
  for (const input of [
    { ...scope, searchTerm: '  ' },
    { ...scope, searchTerm: 'a'.repeat(201) },
    { ...scope, searchTerm: 'bad\0term' },
    { ...scope, searchTerm: 'valid', limit: 101 },
    { ...scope, searchTerm: 'valid', unknown: true },
  ]) assert.throws(() => validateIssueSearchInput(input), IssueSearchDomainError);
});
