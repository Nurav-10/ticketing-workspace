import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Principal } from '../src/auth/authenticator.js';
import { IssueLabelDomainError, IssueLabelApplicationService } from '../src/labels/issue-label-service.js';
import { PrismaIssueLabelRepository } from '../src/labels/prisma-issue-label-repository.js';
import { pool, prisma } from './test-database.js';

const service = new IssueLabelApplicationService(new PrismaIssueLabelRepository(prisma));

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id, provider_subject, email, display_name) VALUES ($1, $2, $3, $4)',
    [id, `issue-labels:${label}:${id}`, `${id}@example.test`, `Issue labels ${label}`]);
  return id;
}

function principal(userId: string): Principal { return { userId, sessionId: `issue-labels:${userId}` }; }

async function expectError<T>(promise: Promise<T>, code: IssueLabelDomainError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof IssueLabelDomainError && error.code === code);
}

test('issue-label replacement is scoped, versioned, and commits assignments, activity and outbox atomically', async () => {
  const users = { owner: await createUser('owner'), member: await createUser('member'), outsider: await createUser('outsider') };
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const teams = { public: randomUUID(), private: randomUUID(), other: randomUUID() };
  const issues = { public: randomUUID(), private: randomUUID() };
  const labels = { first: randomUUID(), second: randomUUID(), otherTeam: randomUUID(), private: randomUUID() };
  const triggerSuffix = randomUUID().replaceAll('-', '');
  const triggerName = `issue_label_fail_outbox_${triggerSuffix}`;
  const functionName = `issue_label_fail_outbox_fn_${triggerSuffix}`;
  let triggerInstalled = false;

  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)',
      [workspaceId, 'Issue labels workspace', `issue-labels-${workspaceId.slice(0, 8)}`, otherWorkspaceId, 'Other workspace', `other-labels-${otherWorkspaceId.slice(0, 8)}`]);
      await setup.query(`INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES
      ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')`, [workspaceId, users.owner, users.member, otherWorkspaceId, users.outsider]);
      await setup.query(`INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES
      ($1, $2, 'Label public team', $3, 'workspace'),
      ($4, $2, 'Label private team', $5, 'private'),
      ($6, $7, 'Label other team', $8, 'workspace')`,
    [teams.public, workspaceId, `P${teams.public.slice(0, 6).toUpperCase()}`, teams.private, `R${teams.private.slice(0, 6).toUpperCase()}`, teams.other, otherWorkspaceId, `O${teams.other.slice(0, 6).toUpperCase()}`]);
      await setup.query('INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)', [workspaceId, teams.private, users.member]);
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally { setup.release(); }
    await pool.query(`INSERT INTO issues(id, workspace_id, team_id, issue_number, title, created_by_user_id) VALUES
      ($1, $2, $3, 1, 'Public issue', $4), ($5, $2, $6, 1, 'Private issue', $4)`,
    [issues.public, workspaceId, teams.public, users.owner, issues.private, teams.private]);
    await pool.query(`INSERT INTO labels(id, workspace_id, team_id, name, normalized_name, color) VALUES
      ($1, $2, $3, 'First', 'first', '#112233'),
      ($4, $2, $3, 'Second', 'second', '#223344'),
      ($5, $9, $6, 'Other team', 'other team', '#334455'),
      ($7, $2, $8, 'Private', 'private', '#445566')`,
    [labels.first, workspaceId, teams.public, labels.second, labels.otherTeam, teams.other, labels.private, teams.private, otherWorkspaceId]);

    // A regular active workspace member can label a workspace-visible issue.
    await expectError(service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 1,
      labelIds: Array.from({ length: 51 }, () => randomUUID()),
    }), 'invalid_issue_label_input');
    await expectError(service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 1, labelIds: [labels.first, labels.first],
    }), 'invalid_issue_label_input');
    const added = await service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 1, labelIds: [labels.first],
    });
    assert.equal(added.version, 2);
    assert.deepEqual(added.labelIds, [labels.first]);
    const loaded = await service.getForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, issueId: issues.public });
    assert.deepEqual(loaded, { workspaceId, teamId: teams.public, issueId: issues.public, version: 2, labelIds: [labels.first] });
    await expectError(service.getForPrincipal(principal(users.outsider), { workspaceId, teamId: teams.public, issueId: issues.public }), 'issue_label_not_found');
    await expectError(service.getForPrincipal(principal(users.owner), { workspaceId, teamId: teams.private, issueId: issues.private }), 'issue_label_not_found');
    const stored = await pool.query(`SELECT i.version, array_agg(il.label_id::text ORDER BY il.label_id::text) AS label_ids
      FROM issues i JOIN issue_labels il ON il.workspace_id = i.workspace_id AND il.team_id = i.team_id AND il.issue_id = i.id
      WHERE i.id = $1 GROUP BY i.version`, [issues.public]);
    assert.deepEqual(stored.rows[0], { version: 2, label_ids: [labels.first] });
    const firstEvent = await pool.query(`SELECT event_kind, metadata, actor_user_id FROM issue_activity_events WHERE issue_id = $1`, [issues.public]);
    assert.equal(firstEvent.rows.length, 1);
    assert.equal(firstEvent.rows[0].event_kind, 'labels_changed');
    assert.deepEqual(firstEvent.rows[0].metadata, { addedLabelIds: [labels.first], removedLabelIds: [] });
    assert.equal(firstEvent.rows[0].actor_user_id, users.member);
    const firstOutbox = await pool.query(`SELECT event_kind, payload FROM outbox_events WHERE issue_id = $1`, [issues.public]);
    assert.deepEqual(firstOutbox.rows, [{ event_kind: 'issue.updated', payload: { issue_id: issues.public, version: 2 } }]);

    // Repeating the current set is a true no-op and still requires the current version.
    const noop = await service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 2, labelIds: [labels.first],
    });
    assert.equal(noop.version, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM issue_activity_events WHERE issue_id = $1', [issues.public])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM outbox_events WHERE issue_id = $1', [issues.public])).rows[0].count, 1);
    await expectError(service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 1, labelIds: [labels.first],
    }), 'issue_label_version_conflict');
    await expectError(service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 2, labelIds: [labels.first, labels.otherTeam],
    }), 'issue_label_not_found');
    await expectError(service.replaceForPrincipal(principal(users.outsider), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 2, labelIds: [],
    }), 'issue_label_forbidden');
    await expectError(service.replaceForPrincipal(principal(users.owner), {
      workspaceId, teamId: teams.private, issueId: issues.private, expectedVersion: 1, labelIds: [labels.private],
    }), 'issue_label_forbidden');

    const replaced = await service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 2, labelIds: [labels.second],
    });
    assert.equal(replaced.version, 3);
    assert.deepEqual(replaced.labelIds, [labels.second]);
    const replacementEvent = await pool.query(`SELECT metadata FROM issue_activity_events WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1`, [issues.public]);
    assert.deepEqual(replacementEvent.rows[0].metadata, { addedLabelIds: [labels.second], removedLabelIds: [labels.first] });

    const privateAssignment = await service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.private, issueId: issues.private, expectedVersion: 1, labelIds: [labels.private],
    });
    assert.equal(privateAssignment.version, 2, 'a private-team member may assign a same-team label');
    assert.deepEqual((await service.getForPrincipal(principal(users.member), { workspaceId, teamId: teams.private, issueId: issues.private })).labelIds, [labels.private]);
    await pool.query('DELETE FROM team_memberships WHERE workspace_id = $1 AND team_id = $2 AND user_id = $3', [workspaceId, teams.private, users.member]);
    await expectError(service.getForPrincipal(principal(users.member), { workspaceId, teamId: teams.private, issueId: issues.private }), 'issue_label_not_found');

    // A failing outbox insert rolls back assignment changes, issue version and activity.
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.issue_id = '${issues.public}'::uuid THEN RAISE EXCEPTION 'test-only issue-label outbox failure'; END IF;
        RETURN NEW;
      END
      $body$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    triggerInstalled = true;
    await assert.rejects(service.replaceForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: issues.public, expectedVersion: 3, labelIds: [labels.first],
    }));
    const afterFailure = await pool.query(`SELECT i.version, array_agg(il.label_id::text ORDER BY il.label_id::text) AS label_ids
      FROM issues i JOIN issue_labels il ON il.workspace_id = i.workspace_id AND il.team_id = i.team_id AND il.issue_id = i.id
      WHERE i.id = $1 GROUP BY i.version`, [issues.public]);
    assert.deepEqual(afterFailure.rows[0], { version: 3, label_ids: [labels.second] });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM issue_activity_events WHERE issue_id = $1', [issues.public])).rows[0].count, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM outbox_events WHERE issue_id = $1', [issues.public])).rows[0].count, 2);
  } finally {
    if (triggerInstalled) {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('SET LOCAL session_replication_role = replica');
      await cleanup.query('DELETE FROM issue_activity_events WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM outbox_events WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM issue_labels WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM issues WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM labels WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM team_memberships WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM teams WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM workspace_memberships WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(users)]);
      await cleanup.query('COMMIT');
    } catch (error) {
      await cleanup.query('ROLLBACK');
      throw error;
    } finally { cleanup.release(); }
  }
});
