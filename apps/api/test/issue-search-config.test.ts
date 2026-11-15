import assert from 'node:assert/strict';
import test from 'node:test';
import { loadIssueSearchCursorKey } from '../src/search/issue-search-config.js';

test('search cursor signing requires an independent canonical 256-bit key', () => {
  const key = Buffer.alloc(32, 1).toString('base64url');
  assert.equal(loadIssueSearchCursorKey({ NODE_ENV: 'development' }), undefined);
  assert.equal(loadIssueSearchCursorKey({ NODE_ENV: 'production', ISSUE_SEARCH_CURSOR_KEY: key }), key);
  assert.throws(() => loadIssueSearchCursorKey({ NODE_ENV: 'production' }));
  assert.throws(() => loadIssueSearchCursorKey({ ISSUE_SEARCH_CURSOR_KEY: 'too-short' }));
  assert.throws(() => loadIssueSearchCursorKey({ ISSUE_SEARCH_CURSOR_KEY: key, RATE_LIMIT_HMAC_KEY: key }));
});
