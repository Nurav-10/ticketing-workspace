import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from './test-database.js';

test('issue query generation tracks committed changes by team and rolls back with writes', async () => {
  const client = await pool.connect();
  const workspace = randomUUID();
  const team = randomUUID();
  const otherTeam = randomUUID();
  const user = randomUUID();
  const issue = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id, email, display_name) VALUES ($1, $2, $3)', [user, `${user}@example.test`, 'Query test']);
    await client.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [workspace, 'Query test', `query-${workspace}`]);
    await client.query("INSERT INTO teams(id, workspace_id, name, key) VALUES ($1, $3, 'One', 'ONE'), ($2, $3, 'Two', 'TWO')", [team, otherTeam, workspace]);
    const generation = async (teamId: string) => BigInt((await client.query('SELECT issue_query_version::text AS value FROM teams WHERE workspace_id = $1 AND id = $2', [workspace, teamId])).rows[0].value);
    const before = await generation(team);
    const otherBefore = await generation(otherTeam);
    await client.query("INSERT INTO issues(id, workspace_id, team_id, issue_number, title, created_by_user_id) VALUES ($1, $2, $3, 1, 'Test', $4)", [issue, workspace, team, user]);
    const afterInsert = await generation(team);
    assert.ok(afterInsert > before);
    assert.equal(await generation(otherTeam), otherBefore);
    await client.query('SAVEPOINT changed');
    await client.query("UPDATE issues SET title = 'Temporary' WHERE id = $1", [issue]);
    assert.ok(await generation(team) > afterInsert);
    await client.query('ROLLBACK TO SAVEPOINT changed');
    assert.equal(await generation(team), afterInsert);
    await client.query("UPDATE issues SET title = 'Persisted' WHERE id = $1", [issue]);
    assert.ok(await generation(team) > afterInsert);
    const afterIssue = await generation(team);
    const label = randomUUID();
    await client.query("INSERT INTO labels(id, workspace_id, team_id, name, normalized_name) VALUES ($1, $2, $3, 'Bug', 'bug')", [label, workspace, team]);
    const afterLabel = await generation(team);
    assert.ok(afterLabel > afterIssue);
    await client.query('INSERT INTO issue_labels(workspace_id, team_id, issue_id, label_id) VALUES ($1, $2, $3, $4)', [workspace, team, issue, label]);
    const afterAssignment = await generation(team);
    assert.ok(afterAssignment > afterLabel);
    await client.query("UPDATE workflow_statuses SET name = 'Changed' WHERE workspace_id = $1 AND team_id = $2 AND key = 'backlog'", [workspace, team]);
    assert.ok(await generation(team) > afterAssignment);
    assert.equal(await generation(otherTeam), otherBefore);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
