import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Principal } from '../src/auth/authenticator.js';
import { IssueDomainError } from '../src/issues/issue-domain.js';
import { IssueApplicationService } from '../src/issues/issue-service.js';
import { PrismaIssueRepository } from '../src/issues/prisma-issue-repository.js';
import { IssueAssigneeApplicationService, PrismaIssueAssigneeRepository } from '../src/issues/issue-assignees.js';
import { ApiError } from '../src/shared/api-error.js';
import { pool, prisma } from './test-database.js';

const service = new IssueApplicationService(new PrismaIssueRepository(prisma));
const assignees = new IssueAssigneeApplicationService(new PrismaIssueAssigneeRepository(prisma));

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO users(id, provider_subject, email, display_name) VALUES ($1, $2, $3, $4)',
    [id, `issues-integration:${label}:${id}`, `${id}@example.test`, `Issues ${label}`],
  );
  return id;
}

function principal(userId: string): Principal {
  return { userId, sessionId: `issues-integration:${userId}` };
}

async function expectIssueError<T>(promise: Promise<T>, code: IssueDomainError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof IssueDomainError && error.code === code);
}

async function countRows(table: 'issues' | 'issue_activity_events' | 'outbox_events', workspaceId: string): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
  return result.rows[0].count as number;
}

test('PostgreSQL issue slice enforces tenant access, numbering, idempotency, CAS and atomic history', async () => {
  const users = {
    owner: await createUser('owner'),
    member: await createUser('member'),
    outsider: await createUser('outsider'),
    invalidAssignee: await createUser('invalid-assignee'),
  };
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const teams = { public: randomUUID(), private: randomUUID(), otherWorkspace: randomUUID() };
  const keys = Object.fromEntries(Object.entries(teams).map(([name, id]) => [name, `I${id.slice(0, 7).toUpperCase()}`])) as Record<keyof typeof teams, string>;
  const triggerSuffix = randomUUID().replaceAll('-', '');
  const triggerName = `issue_test_fail_outbox_${triggerSuffix}`;
  const functionName = `issue_test_fail_outbox_fn_${triggerSuffix}`;
  let failureTriggerInstalled = false;

  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query(
        'INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)',
        [workspaceId, 'Issue test workspace', `issues-${workspaceId.slice(0, 8)}`, otherWorkspaceId, 'Issue other workspace', `other-${otherWorkspaceId.slice(0, 8)}`],
      );
      await setup.query(
        `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES
          ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')`,
        [workspaceId, users.owner, users.member, otherWorkspaceId, users.outsider],
      );
      await setup.query(
        `INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES
          ($1, $2, 'Public issue team', $3, 'workspace'),
          ($4, $2, 'Private issue team', $5, 'private'),
          ($6, $7, 'Other workspace team', $8, 'workspace')`,
        [teams.public, workspaceId, keys.public, teams.private, keys.private, teams.otherWorkspace, otherWorkspaceId, keys.otherWorkspace],
      );
      await setup.query(
        'INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)',
        [workspaceId, teams.private, users.member],
      );
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally { setup.release(); }

    await assert.rejects(
      assignees.listForPrincipal(principal(users.owner), { workspaceId, teamId: teams.private }),
      (error: unknown) => error instanceof ApiError && error.statusCode === 404,
    );
    const privateAssignees = await assignees.listForPrincipal(principal(users.member), { workspaceId, teamId: teams.private });
    assert.deepEqual(privateAssignees.items.map((person) => person.id), [users.member]);
    assert.deepEqual(Object.keys(privateAssignees.items[0]!).sort(), ['displayName', 'id']);

    // Workspace owners have no implicit access to private-team content.
    await expectIssueError(service.createForPrincipal(principal(users.owner), {
      workspaceId, teamId: teams.private, title: 'Denied private issue', idempotencyKey: 'private-denied',
    }), 'issue_forbidden');

    await expectIssueError(service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'Invalid assignee', assigneeUserId: users.invalidAssignee,
      idempotencyKey: 'invalid-assignee',
    }), 'issue_assignee_unavailable');
    const counterAfterRejectedAssignee = await pool.query('SELECT next_issue_number FROM teams WHERE id = $1', [teams.public]);
    assert.equal(counterAfterRejectedAssignee.rows[0].next_issue_number, 1, 'rejected assignee must not consume a number');

    const first = await service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'First issue', idempotencyKey: 'create-first',
    });
    assert.equal(first.issueNumber, 1);
    const replay = await service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'First issue', idempotencyKey: 'create-first',
    });
    assert.equal(replay.id, first.id, 'same key and canonical payload returns the original issue');
    await expectIssueError(service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'Changed payload', idempotencyKey: 'create-first',
    }), 'issue_idempotency_conflict');
    await expectIssueError(service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.private, title: 'Other team payload', idempotencyKey: 'create-first',
    }), 'issue_idempotency_conflict');

    const raced = await Promise.all(Array.from({ length: 8 }, (_, index) => service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: `Concurrent issue ${index}`, idempotencyKey: `concurrent-${index}`,
    })));
    assert.deepEqual([...raced.map((issue) => issue.issueNumber).sort((a, b) => a - b)], [2, 3, 4, 5, 6, 7, 8, 9]);
    await pool.query('UPDATE issues SET created_at = date_trunc(\'milliseconds\', statement_timestamp()) WHERE workspace_id = $1 AND team_id = $2', [workspaceId, teams.public]);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await service.listForPrincipal(principal(users.member), {
        workspaceId, teamId: teams.public, limit: 2, ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        assert.ok(!seen.has(item.id), 'pagination must not repeat issues');
        seen.add(item.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 9, 'pagination must not skip issues created in the same millisecond');

    const privateIssue = await service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.private, title: 'Private team issue', idempotencyKey: 'private-member-create',
    });
    assert.equal(privateIssue.issueNumber, 1, 'numbering is per team');
    await expectIssueError(service.getForPrincipal(principal(users.owner), {
      workspaceId, teamId: teams.private, issueId: privateIssue.id,
    }), 'issue_not_found');
    await expectIssueError(service.getForPrincipal(principal(users.member), {
      workspaceId: otherWorkspaceId, teamId: teams.otherWorkspace, issueId: first.id,
    }), 'issue_not_found');
    await expectIssueError(service.getForPrincipal(principal(users.outsider), {
      workspaceId, teamId: teams.public, issueId: first.id,
    }), 'issue_not_found');

    const beforeRace = await service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'Versioned issue', idempotencyKey: 'versioned',
    });
    const mutationRace = await Promise.allSettled([
      service.updateForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, issueId: beforeRace.id, expectedVersion: 1, title: 'Winner title' }),
      service.updateForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, issueId: beforeRace.id, expectedVersion: 1, priority: 'high' }),
    ]);
    assert.equal(mutationRace.filter((result) => result.status === 'fulfilled').length, 1);
    const rejectedMutation = mutationRace.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.ok(rejectedMutation);
    assert.ok(rejectedMutation.reason instanceof IssueDomainError);
    assert.equal(rejectedMutation.reason.code, 'issue_version_conflict');
    const current = (await service.getForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: beforeRace.id,
    })).issue;
    assert.equal(current.version, 2);
    await expectIssueError(service.updateForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: current.id, expectedVersion: 1, title: current.title,
    }), 'issue_version_conflict');
    await expectIssueError(service.transitionForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: current.id, expectedVersion: current.version, targetStatus: 'done',
    }), 'issue_invalid_transition');
    const transitioned = await service.transitionForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: current.id, expectedVersion: current.version, targetStatus: 'todo',
    });
    assert.equal(transitioned.version, 3);

    const beforeFailure = await service.getForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: beforeRace.id,
    });
    await pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.issue_id = '${beforeRace.id}'::uuid THEN
          RAISE EXCEPTION 'test-only outbox failure';
        END IF;
        RETURN NEW;
      END
      $body$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    failureTriggerInstalled = true;
    await assert.rejects(service.updateForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: beforeRace.id, expectedVersion: transitioned.version, title: 'Must roll back',
    }));
    const afterFailure = await service.getForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: beforeRace.id,
    });
    assert.equal(afterFailure.issue.version, beforeFailure.issue.version);
    assert.equal(afterFailure.issue.title, beforeFailure.issue.title);
    assert.equal(afterFailure.activity.length, beforeFailure.activity.length, 'failed outbox write rolls back issue activity');
    await pool.query(`DROP TRIGGER ${triggerName} ON outbox_events`);
    await pool.query(`DROP FUNCTION ${functionName}()`);
    failureTriggerInstalled = false;

    const archived = await service.archiveForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: beforeRace.id, expectedVersion: afterFailure.issue.version,
    });
    assert.ok(archived.archivedAt);
    const defaultList = await service.listForPrincipal(principal(users.member), { workspaceId, teamId: teams.public });
    assert.ok(!defaultList.items.some((issue) => issue.id === beforeRace.id));
    const archivedList = await service.listForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, archived: true });
    assert.ok(archivedList.items.some((issue) => issue.id === beforeRace.id), 'archived issues remain discoverable to authorized members');
    const archivedDetail = await service.getForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: beforeRace.id,
    });
    assert.equal(archivedDetail.issue.id, beforeRace.id, 'archived issues remain readable with history');
    const restored = await service.restoreForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, issueId: beforeRace.id, expectedVersion: archived.version,
    });
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.version, archived.version + 1);

    const activityCount = await countRows('issue_activity_events', workspaceId);
    const outboxCount = await countRows('outbox_events', workspaceId);
    const issueCount = await countRows('issues', workspaceId);
    assert.equal(activityCount, outboxCount, 'every committed issue mutation has one activity and one outbox event');
    assert.equal(activityCount, issueCount + 4, 'first create has one event; retries and rejected/conflicting commands add none');
    assert.equal(await countRows('issues', otherWorkspaceId), 0);

    await pool.query(
      `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [otherWorkspaceId, users.owner, users.member],
    );
    const reciprocal = await Promise.all([
      service.createForPrincipal(principal(users.owner), { workspaceId, teamId: teams.public, title: 'Assign member', assigneeUserId: users.member, idempotencyKey: 'cross-workspace-a' }),
      service.createForPrincipal(principal(users.member), { workspaceId: otherWorkspaceId, teamId: teams.otherWorkspace, title: 'Assign owner', assigneeUserId: users.owner, idempotencyKey: 'cross-workspace-b' }),
    ]);
    assert.equal(reciprocal.length, 2, 'reciprocal cross-workspace assignments must not deadlock');

    await pool.query(
      `UPDATE issue_idempotency_records SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
       WHERE workspace_id = $1 AND actor_user_id = $2 AND operation = 'issue.create' AND key = $3`,
      [workspaceId, users.member, 'create-first'],
    );
    const reused = await service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'New request after expiration', idempotencyKey: 'create-first',
    });
    assert.notEqual(reused.id, first.id, 'an expired key can be reused for a new authorized request');
    const duplicateRequests = await Promise.all([0, 1].map(() => service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'One issue across retries', idempotencyKey: 'same-key-race',
    })));
    assert.equal(duplicateRequests[0]?.id, duplicateRequests[1]?.id, 'simultaneous identical retries must not duplicate an issue');
    const crossTeamRace = await Promise.allSettled([
      service.createForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, title: 'Cross-team retry', idempotencyKey: 'cross-team-race' }),
      service.createForPrincipal(principal(users.member), { workspaceId, teamId: teams.private, title: 'Cross-team retry', idempotencyKey: 'cross-team-race' }),
    ]);
    assert.equal(crossTeamRace.filter((result) => result.status === 'fulfilled').length, 1);
    const crossTeamRejected = crossTeamRace.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.ok(crossTeamRejected?.reason instanceof IssueDomainError && crossTeamRejected.reason.code === 'issue_idempotency_conflict');
    await pool.query('UPDATE teams SET next_issue_number = 2147483647 WHERE id = $1', [teams.public]);
    await expectIssueError(service.createForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, title: 'Counter exhausted', idempotencyKey: 'counter-exhausted',
    }), 'issue_number_exhausted');
    await pool.query(
      `UPDATE issue_idempotency_records SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
       WHERE workspace_id = $1 AND actor_user_id = $2 AND operation = 'issue.create' AND key = $3`,
      [workspaceId, users.member, 'create-first'],
    );
    await new PrismaIssueRepository(prisma).deleteExpiredIdempotencyRecords(5_000);
    const retainedKeys = await pool.query('SELECT key FROM issue_idempotency_records WHERE workspace_id = $1', [workspaceId]);
    assert.ok(!retainedKeys.rows.some((row) => row.key === 'create-first'));
    assert.ok(retainedKeys.rows.some((row) => row.key === 'same-key-race'), 'cleanup must preserve live records');
  } finally {
    if (failureTriggerInstalled) {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('SET LOCAL session_replication_role = replica');
      await cleanup.query('DELETE FROM issue_idempotency_records WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM issue_activity_events WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM outbox_events WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
      await cleanup.query('DELETE FROM issues WHERE workspace_id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
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
