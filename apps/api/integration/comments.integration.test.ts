import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Principal } from '../src/auth/authenticator.js';
import { CommentDomainError } from '../src/comments/comment-domain.js';
import { CommentApplicationService } from '../src/comments/comment-service.js';
import { PrismaCommentRepository } from '../src/comments/prisma-comment-repository.js';
import { pool, prisma } from './test-database.js';

const comments = new CommentApplicationService(new PrismaCommentRepository(prisma));

function principal(userId: string): Principal { return { userId, sessionId: `comments-integration:${userId}` }; }

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id, provider_subject, email, display_name) VALUES ($1, $2, $3, $4)',
    [id, `comments-integration:${label}:${id}`, `${id}@example.test`, `Comment ${label}`]);
  return id;
}

async function expectCommentError<T>(promise: Promise<T>, code: CommentDomainError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof CommentDomainError && error.code === code);
}

test('PostgreSQL comments enforce team and author scope, versions, soft deletion, and atomic history', async () => {
  const users = {
    owner: await createUser('owner'),
    member: await createUser('member'),
    outsider: await createUser('outsider'),
  };
  const workspaceId = randomUUID();
  const teamIds = { workspace: randomUUID(), private: randomUUID() };
  const issueIds = { workspace: randomUUID(), private: randomUUID() };
  const keyPrefix = `C${randomUUID().slice(0, 5).toUpperCase()}`;
  const triggerSuffix = randomUUID().replaceAll('-', '');
  const triggerName = `comment_fail_outbox_${triggerSuffix}`;
  const functionName = `comment_fail_outbox_fn_${triggerSuffix}`;
  let failureTriggerInstalled = false;

  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)', [workspaceId, 'Comment test workspace', `comments-${workspaceId.slice(0, 8)}`]);
      await setup.query("INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [workspaceId, users.owner, users.member]);
      await setup.query(`INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES
        ($1, $3, 'Comment workspace team', $4, 'workspace'), ($2, $3, 'Comment private team', $5, 'private')`,
      [teamIds.workspace, teamIds.private, workspaceId, `${keyPrefix}W`, `${keyPrefix}P`]);
      await setup.query('INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)', [workspaceId, teamIds.private, users.member]);
      await setup.query(`INSERT INTO issues(id, workspace_id, team_id, issue_number, title, created_by_user_id) VALUES
        ($1, $3, $4, 1, 'Comment target', $6), ($2, $3, $5, 1, 'Private comment target', $6)`,
      [issueIds.workspace, issueIds.private, workspaceId, teamIds.workspace, teamIds.private, users.member]);
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally { setup.release(); }

    const scope = { workspaceId, teamId: teamIds.workspace, issueId: issueIds.workspace };
    await expectCommentError(comments.createForPrincipal(principal(users.outsider), { ...scope, body: 'Outsider text' }), 'comment_forbidden');
    await expectCommentError(comments.createForPrincipal(principal(users.owner), {
      workspaceId, teamId: teamIds.private, issueId: issueIds.private, body: 'Private text',
    }), 'comment_forbidden');
    await expectCommentError(comments.listForPrincipal(principal(users.owner), {
      workspaceId, teamId: teamIds.private, issueId: issueIds.private,
    }), 'comment_not_found');

    const created = await comments.createForPrincipal(principal(users.member), { ...scope, body: '  First comment  ' });
    assert.equal(created.body, 'First comment');
    assert.equal(created.format, 'plain_text');
    assert.equal(created.authorUserId, users.member);
    assert.equal(created.version, 1);
    const page = await comments.listForPrincipal(principal(users.member), { ...scope });
    assert.deepEqual(page.items.map((item) => item.id), [created.id]);

    await expectCommentError(comments.updateForPrincipal(principal(users.owner), {
      ...scope, commentId: created.id, expectedVersion: 1, body: 'Owner cannot edit',
    }), 'comment_forbidden');
    const editRace = await Promise.allSettled([
      comments.updateForPrincipal(principal(users.member), { ...scope, commentId: created.id, expectedVersion: 1, body: 'Updated comment A' }),
      comments.updateForPrincipal(principal(users.member), { ...scope, commentId: created.id, expectedVersion: 1, body: 'Updated comment B' }),
    ]);
    assert.equal(editRace.filter((result) => result.status === 'fulfilled').length, 1, 'only one simultaneous edit can use a comment version');
    const editedResult = editRace.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof comments.updateForPrincipal>>> => result.status === 'fulfilled');
    assert.ok(editedResult);
    const edited = editedResult.value;
    assert.match(edited.body ?? '', /^Updated comment [AB]$/);
    assert.equal(edited.version, 2);
    assert.ok(edited.editedAt);
    await expectCommentError(comments.updateForPrincipal(principal(users.member), {
      ...scope, commentId: created.id, expectedVersion: 1, body: 'Stale edit',
    }), 'comment_version_conflict');

    await expectCommentError(comments.deleteForPrincipal(principal(users.owner), {
      ...scope, commentId: created.id, expectedVersion: 2,
    }), 'comment_forbidden');

    const deleted = await comments.deleteForPrincipal(principal(users.member), {
      ...scope, commentId: created.id, expectedVersion: 2,
    });
    assert.equal(deleted.body, null);
    assert.ok(deleted.deletedAt);
    assert.equal(deleted.version, 3);
    assert.deepEqual((await comments.listForPrincipal(principal(users.member), { ...scope })).items, []);

    await expectCommentError(comments.updateForPrincipal(principal(users.member), {
      ...scope, commentId: created.id, expectedVersion: 3, body: 'Revive attempt',
    }), 'comment_not_found');
    await expectCommentError(comments.deleteForPrincipal(principal(users.member), {
      ...scope, commentId: created.id, expectedVersion: 3,
    }), 'comment_not_found');

    const metadata = await pool.query(
      "SELECT event_kind, metadata FROM issue_activity_events WHERE issue_id = $1 ORDER BY created_at, id", [issueIds.workspace],
    );
    assert.deepEqual(metadata.rows.map((row) => row.event_kind), ['comment_created', 'comment_edited', 'comment_deleted']);
    assert.ok(metadata.rows.every((row) => !JSON.stringify(row.metadata).includes('Updated comment')),
      'activity metadata must not contain comment content');
    const outbox = await pool.query("SELECT event_kind, payload FROM outbox_events WHERE issue_id = $1 ORDER BY created_at, id", [issueIds.workspace]);
    assert.deepEqual(outbox.rows.map((row) => row.event_kind), ['issue.comment.created', 'issue.comment.updated', 'issue.comment.deleted']);
    assert.ok(outbox.rows.every((row) => !JSON.stringify(row.payload).includes('Updated comment')),
      'outbox payload must not contain comment content');

    const privateScope = { workspaceId, teamId: teamIds.private, issueId: issueIds.private };
    const paginated1 = await comments.createForPrincipal(principal(users.member), { ...privateScope, body: 'Pagination comment 1' });
    const paginated2 = await comments.createForPrincipal(principal(users.member), { ...privateScope, body: 'Pagination comment 2' });
    const firstPage = await comments.listForPrincipal(principal(users.member), { ...privateScope, limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].id, paginated1.id);
    assert.ok(firstPage.nextCursor);
    const secondPage = await comments.listForPrincipal(principal(users.member), { ...privateScope, limit: 1, cursor: firstPage.nextCursor });
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.items[0].id, paginated2.id);

    await pool.query('UPDATE issues SET archived_at = clock_timestamp() WHERE id = $1', [issueIds.private]);
    await expectCommentError(comments.createForPrincipal(principal(users.member), {
      ...privateScope, body: 'Archived issue comment',
    }), 'comment_not_found');

    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.issue_id = '${issueIds.workspace}'::uuid AND NEW.event_kind = 'issue.comment.created' THEN
          RAISE EXCEPTION 'test-only comment outbox failure';
        END IF;
        RETURN NEW;
      END
      $body$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    failureTriggerInstalled = true;
    const beforeFailure = await pool.query('SELECT count(*)::int AS count FROM comments WHERE issue_id = $1', [issueIds.workspace]);
    const beforeFailureEvents = await pool.query('SELECT count(*)::int AS count FROM issue_activity_events WHERE issue_id = $1', [issueIds.workspace]);
    await assert.rejects(comments.createForPrincipal(principal(users.member), { ...scope, body: 'Must roll back' }));
    const afterFailure = await pool.query('SELECT count(*)::int AS count FROM comments WHERE issue_id = $1', [issueIds.workspace]);
    const afterFailureEvents = await pool.query('SELECT count(*)::int AS count FROM issue_activity_events WHERE issue_id = $1', [issueIds.workspace]);
    assert.equal(afterFailure.rows[0].count, beforeFailure.rows[0].count, 'failed outbox write rolls back the comment');
    assert.equal(afterFailureEvents.rows[0].count, beforeFailureEvents.rows[0].count, 'failed outbox write rolls back activity');
  } finally {
    if (failureTriggerInstalled) {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('SET LOCAL session_replication_role = replica');
      await cleanup.query('DELETE FROM comments WHERE workspace_id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM issue_activity_events WHERE workspace_id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM outbox_events WHERE workspace_id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM issues WHERE workspace_id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM team_memberships WHERE workspace_id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM teams WHERE workspace_id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(users)]);
      await cleanup.query('COMMIT');
    } catch (error) {
      await cleanup.query('ROLLBACK');
      throw error;
    } finally { cleanup.release(); }
  }
});
