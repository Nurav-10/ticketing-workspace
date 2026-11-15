import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from './test-database.js';

test('labels are unique per team and issue assignments cannot cross teams', async () => {
  const client = await pool.connect();
  const workspace = randomUUID();
  const team = randomUUID();
  const otherTeam = randomUUID();
  const user = randomUUID();
  const issue = randomUUID();
  const label = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id, email, display_name) VALUES ($1, $2, $3)', [user, `${user}@example.test`, 'Label test']);
    await client.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [workspace, 'Label test', `label-${workspace}`]);
    await client.query("INSERT INTO teams(id, workspace_id, name, key) VALUES ($1, $3, 'One', 'ONE'), ($2, $3, 'Two', 'TWO')", [team, otherTeam, workspace]);
    await client.query("INSERT INTO issues(id, workspace_id, team_id, issue_number, title, created_by_user_id) VALUES ($1, $2, $3, 1, 'Test', $4)", [issue, workspace, team, user]);
    await client.query("INSERT INTO labels(id, workspace_id, team_id, name, normalized_name) VALUES ($1, $2, $3, 'Bug', 'bug')", [label, workspace, otherTeam]);
    await client.query('SAVEPOINT unique_check');
    await assert.rejects(client.query("INSERT INTO labels(workspace_id, team_id, name, normalized_name) VALUES ($1, $2, 'BUG', 'bug')", [workspace, otherTeam]), { code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT unique_check');
    await client.query('SAVEPOINT scope_check');
    await assert.rejects(client.query('INSERT INTO issue_labels(workspace_id, team_id, issue_id, label_id) VALUES ($1, $2, $3, $4)', [workspace, team, issue, label]), { code: '23503' });
    await client.query('ROLLBACK TO SAVEPOINT scope_check');
    await client.query("INSERT INTO labels(workspace_id, team_id, name, normalized_name) VALUES ($1, $2, 'Bug', 'bug')", [workspace, team]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
