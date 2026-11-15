import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Principal } from '../src/auth/authenticator.js';
import { IssueSearchDomainError } from '../src/search/issue-search-domain.js';
import { IssueSearchApplicationService } from '../src/search/issue-search-service.js';
import { PrismaIssueSearchRepository } from '../src/search/prisma-issue-search-repository.js';
import { pool, prisma } from './test-database.js';

const service = new IssueSearchApplicationService(new PrismaIssueSearchRepository(prisma, 'issue-search-integration-cursor-secret-32-bytes'));

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id, provider_subject, email, display_name) VALUES ($1, $2, $3, $4)',
    [id, `issue-search:${label}:${id}`, `${id}@example.test`, `Issue search ${label}`]);
  return id;
}

function principal(userId: string): Principal { return { userId, sessionId: `issue-search:${userId}` }; }

async function expectSearchError<T>(promise: Promise<T>, code: IssueSearchDomainError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof IssueSearchDomainError && error.code === code);
}

test('issue search scopes privacy before ranking and paginates equal ranks with actor-bound cursors', async () => {
  const users = { owner: await createUser('owner'), member: await createUser('member'), outsider: await createUser('outsider') };
  const workspaceId = randomUUID();
  const teams = { public: randomUUID(), private: randomUUID(), other: randomUUID() };
  const issues = {
    publicNeedle: randomUUID(), archivedNeedle: randomUUID(), privateNeedle: randomUUID(), otherNeedle: randomUUID(),
    edited: randomUUID(), rankA: randomUUID(), rankB: randomUUID(), rankC: randomUUID(),
  };
  const archivedAt = new Date('2026-01-01T00:00:00Z');

  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3)',
        [workspaceId, 'Issue search workspace', `issue-search-${workspaceId.slice(0, 8)}`]);
      await setup.query(`INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES
        ($1, $2, 'owner'), ($1, $3, 'member')`, [workspaceId, users.owner, users.member]);
      await setup.query(`INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES
        ($1, $2, 'Search public', $3, 'workspace'), ($4, $2, 'Search private', $5, 'private'), ($6, $2, 'Search other', $7, 'workspace')`,
      [teams.public, workspaceId, `P${teams.public.slice(0, 6).toUpperCase()}`, teams.private, `R${teams.private.slice(0, 6).toUpperCase()}`, teams.other, `O${teams.other.slice(0, 6).toUpperCase()}`]);
      await setup.query('INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)', [workspaceId, teams.private, users.member]);
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally { setup.release(); }
    await pool.query(`INSERT INTO issues(id, workspace_id, team_id, issue_number, title, description, created_by_user_id, archived_at) VALUES
      ($1, $2, $3, 1, 'Needle public', 'safe body', $4, NULL),
      ($5, $2, $3, 2, 'Needle archived', NULL, $4, $8),
      ($6, $2, $9, 1, 'Needle private', NULL, $4, NULL),
      ($7, $2, $10, 1, 'Needle other team', NULL, $4, NULL),
      ($11, $2, $3, 3, 'Oldphrase', 'text changed later', $4, NULL),
      ($12, $2, $3, 4, 'Rankphrase', NULL, $4, NULL),
      ($13, $2, $3, 5, 'Rankphrase', NULL, $4, NULL),
      ($14, $2, $3, 6, 'Rankphrase', NULL, $4, NULL)`,
    [issues.publicNeedle, workspaceId, teams.public, users.owner, issues.archivedNeedle, issues.privateNeedle, issues.otherNeedle,
      archivedAt, teams.private, teams.other, issues.edited, issues.rankA, issues.rankB, issues.rankC]);

    // Workspace-visible search cannot return matching private or other-team rows.
    const publicPage = await service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, searchTerm: 'needle' });
    assert.deepEqual(publicPage.items.map((item) => item.id), [issues.publicNeedle]);
    assert.equal(publicPage.items.length, 1);
    assert.deepEqual(Object.keys(publicPage).sort(), ['items']);
    assert.deepEqual(Object.keys(publicPage.items[0]!).sort(), [
      'archivedAt', 'assigneeUserId', 'createdAt', 'createdByUserId', 'id', 'issueNumber', 'key',
      'priority', 'status', 'teamId', 'title', 'updatedAt', 'version', 'workspaceId',
    ]);
    await expectSearchError(service.searchForPrincipal(principal(users.owner), { workspaceId, teamId: teams.private, searchTerm: 'needle' }), 'issue_search_not_found');
    await expectSearchError(service.searchForPrincipal(principal(users.outsider), { workspaceId, teamId: teams.public, searchTerm: 'needle' }), 'issue_search_not_found');
    const privatePage = await service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.private, searchTerm: 'needle' });
    assert.deepEqual(privatePage.items.map((item) => item.id), [issues.privateNeedle]);
    await pool.query('DELETE FROM team_memberships WHERE workspace_id = $1 AND team_id = $2 AND user_id = $3', [workspaceId, teams.private, users.member]);
    await expectSearchError(service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.private, searchTerm: 'needle' }), 'issue_search_not_found');
    const otherPage = await service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.other, searchTerm: 'needle' });
    assert.deepEqual(otherPage.items.map((item) => item.id), [issues.otherNeedle]);

    // Archive mode defaults to active, and archived-only results stay scoped.
    const archivedOnly = await service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, searchTerm: 'needle', archiveMode: 'archived' });
    assert.deepEqual(archivedOnly.items.map((item) => item.id), [issues.archivedNeedle]);
    const allNeedleFirst = await service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, searchTerm: 'needle', archiveMode: 'all', limit: 1 });
    assert.ok(allNeedleFirst.nextCursor);

    // The generated vector reflects edited title/description immediately.
    await pool.query('UPDATE issues SET title = $1 WHERE id = $2', ['Freshphrase', issues.edited]);
    const fresh = await service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, searchTerm: 'freshphrase' });
    assert.deepEqual(fresh.items.map((item) => item.id), [issues.edited]);
    const old = await service.searchForPrincipal(principal(users.member), { workspaceId, teamId: teams.public, searchTerm: 'oldphrase' });
    assert.deepEqual(old.items, []);
    await pool.query('UPDATE issues SET title = $1 WHERE id = $2', ['Changed public issue', issues.publicNeedle]);
    await expectSearchError(service.searchForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, searchTerm: 'needle', archiveMode: 'all', limit: 1, cursor: allNeedleFirst.nextCursor!,
    }), 'issue_search_cursor_stale');

    // Equal rank pages use issue ID as a deterministic tie-breaker.
    const rankScores = await pool.query(`SELECT count(DISTINCT ts_rank_cd(search_vector, plainto_tsquery('pg_catalog.simple'::regconfig, 'rankphrase')))::int AS score_count
      FROM issues WHERE id = ANY($1::uuid[])`, [[issues.rankA, issues.rankB, issues.rankC]]);
    assert.equal(rankScores.rows[0].score_count, 1);
    const expectedIds = [issues.rankA, issues.rankB, issues.rankC].sort();
    const traversed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.searchForPrincipal(principal(users.member), {
        workspaceId, teamId: teams.public, searchTerm: 'rankphrase', limit: 1, ...(cursor ? { cursor } : {}),
      });
      traversed.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(traversed, expectedIds);

    // Validly signed cursors still cannot be replayed across teams or principals.
    await expectSearchError(service.searchForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.other, searchTerm: 'needle', archiveMode: 'all', limit: 1, cursor: allNeedleFirst.nextCursor!,
    }), 'invalid_issue_search_input');
    await expectSearchError(service.searchForPrincipal(principal(users.owner), {
      workspaceId, teamId: teams.public, searchTerm: 'needle', archiveMode: 'all', limit: 1, cursor: allNeedleFirst.nextCursor!,
    }), 'invalid_issue_search_input');
    await expectSearchError(service.searchForPrincipal(principal(users.member), {
      workspaceId, teamId: teams.public, searchTerm: 'needle', archiveMode: 'all', limit: 1, cursor: 'forged.cursor',
    }), 'invalid_issue_search_input');
  } finally {
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('SET LOCAL session_replication_role = replica');
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
