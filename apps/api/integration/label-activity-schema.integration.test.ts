import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from './test-database.js';

test('label activity allows only bounded distinct identifiers and preserves other activity rules', async () => {
  const valid = async (kind: string, metadata: unknown): Promise<boolean> => {
    const result = await pool.query('SELECT issue_activity_metadata_is_safe($1::issue_activity_kind, $2::jsonb) AS valid', [kind, JSON.stringify(metadata)]);
    return result.rows[0].valid;
  };
  const id = randomUUID();
  try {
    assert.equal(await valid('labels_changed', { addedLabelIds: [id], removedLabelIds: [] }), true);
    assert.equal(await valid('labels_changed', { addedLabelIds: [], removedLabelIds: [] }), false);
    assert.equal(await valid('labels_changed', { addedLabelIds: [id], removedLabelIds: [id.toUpperCase()] }), false);
    assert.equal(await valid('labels_changed', { addedLabelIds: ['bad'], removedLabelIds: [] }), false);
    assert.equal(await valid('labels_changed', { addedLabelIds: [id], removedLabelIds: [], title: 'private' }), false);
    assert.equal(await valid('labels_changed', { addedLabelIds: Array.from({ length: 101 }, () => randomUUID()), removedLabelIds: [] }), false);
    assert.equal(await valid('created', {}), true);
    assert.equal(await valid('created', { title: 'private' }), false);
    assert.equal(await valid('status_changed', { statusBefore: 'backlog', statusAfter: 'todo' }), true);
  } finally { await pool.end(); }
});
