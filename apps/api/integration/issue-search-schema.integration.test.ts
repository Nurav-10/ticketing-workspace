import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from './test-database.js';

test('search data follows title and description changes', async () => {
  const client = await pool.connect();
  const workspace = randomUUID();
  const team = randomUUID();
  const user = randomUUID();
  const issue = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id, email, display_name) VALUES ($1, $2, $3)', [user, `${user}@example.test`, 'Search test']);
    await client.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [workspace, 'Search test', `search-${workspace}`]);
    await client.query("INSERT INTO teams(id, workspace_id, name, key) VALUES ($1, $2, 'Search', 'SEARCH')", [team, workspace]);
    await client.query("INSERT INTO issues(id, workspace_id, team_id, issue_number, title, description, created_by_user_id) VALUES ($1, $2, $3, 1, 'Quartz setup', 'Calibrate compass', $4)", [issue, workspace, team, user]);
    const matches = async (query: string): Promise<number> => {
      const result = await client.query("SELECT count(*)::int AS count FROM issues WHERE id = $1 AND search_vector @@ plainto_tsquery('pg_catalog.simple'::regconfig, $2)", [issue, query]);
      return result.rows[0].count;
    };
    assert.equal(await matches('quartz'), 1);
    assert.equal(await matches('compass'), 1);
    await client.query("UPDATE issues SET title = 'Ocean setup', description = NULL WHERE id = $1", [issue]);
    assert.equal(await matches('quartz'), 0);
    assert.equal(await matches('compass'), 0);
    assert.equal(await matches('ocean'), 1);
    const index = await client.query("SELECT 1 FROM pg_indexes WHERE tablename = 'issues' AND indexname = 'issues_search_vector_gin_idx' AND indexdef LIKE '%USING gin%'");
    assert.equal(index.rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
