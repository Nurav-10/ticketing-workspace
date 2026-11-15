import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ApiError } from '../src/shared/api-error.js';
import { PlanningApplicationService } from '../src/planning/planning-service.js';
import { PrismaPlanningRepository } from '../src/planning/prisma-planning-repository.js';
import { pool, prisma } from './test-database.js';

const service = new PlanningApplicationService(new PrismaPlanningRepository(prisma));
const principal = (userId: string) => ({ userId, sessionId: `planning:${userId}` });
const errorCode = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof ApiError && error.code === code);

async function makeUser(label: string) {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id, provider_subject, email, display_name) VALUES ($1, $2, $3, $4)', [id, `planning:${label}:${id}`, `${id}@example.test`, label]);
  return id;
}

test('Phase 6 planning scopes private teams, rejects foreign grouping, and serializes cycle overlap', async () => {
  const owner = await makeUser('owner');
  const member = await makeUser('member');
  const outsider = await makeUser('outsider');
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const teamId = randomUUID();
  const privateTeamId = randomUUID();
  const otherTeamId = randomUUID();
  const foreignTeamId = randomUUID();
  const issueId = randomUUID();
  const privateIssueId = randomUUID();
  const otherIssueId = randomUUID();
  const foreignIssueId = randomUUID();
  const allWorkspaces = [workspaceId, otherWorkspaceId];

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)', [workspaceId, 'Planning', `planning-${workspaceId.slice(0, 8)}`, otherWorkspaceId, 'Foreign', `foreign-${otherWorkspaceId.slice(0, 8)}`]);
      await client.query('INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, \'owner\'), ($1, $3, \'member\'), ($4, $5, \'owner\')', [workspaceId, owner, member, otherWorkspaceId, outsider]);
      await client.query(`INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES
        ($1, $2, 'Public', 'PUB', 'workspace'), ($3, $2, 'Private', 'PRV', 'private'),
        ($4, $2, 'Other team', 'OTH', 'workspace'), ($5, $6, 'Foreign team', 'FOR', 'workspace')`, [teamId, workspaceId, privateTeamId, otherTeamId, foreignTeamId, otherWorkspaceId]);
      await client.query('INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)', [workspaceId, privateTeamId, member]);
      await client.query(`INSERT INTO issues(id, workspace_id, team_id, issue_number, title, created_by_user_id) VALUES
        ($1, $2, $3, 1, 'Project issue', $4), ($5, $2, $6, 1, 'Private issue', $4),
        ($7, $2, $8, 1, 'Other team issue', $4), ($9, $10, $11, 1, 'Foreign issue', $12)`,
      [issueId, workspaceId, teamId, owner, privateIssueId, privateTeamId, otherIssueId, otherTeamId, foreignIssueId, otherWorkspaceId, foreignTeamId, outsider]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }

    await errorCode(service.listProjects(principal(owner), { workspaceId, teamId: privateTeamId }), 'team_not_found');
    await errorCode(service.listCycles(principal(owner), { workspaceId, teamId: privateTeamId }), 'team_not_found');
    await errorCode(service.createProject(principal(owner), { workspaceId, teamId: privateTeamId, name: 'Denied project' }), 'team_not_found');
    await errorCode(service.createCycle(principal(owner), { workspaceId, teamId: privateTeamId, name: 'Denied cycle', startAt: new Date('2032-01-01T00:00:00Z'), endAt: new Date('2032-02-01T00:00:00Z') }), 'team_not_found');

    const privateProject = await service.createProject(principal(member), { workspaceId, teamId: privateTeamId, name: 'Private plan' }) as { id: string };
    assert.ok(privateProject.id);

    await errorCode(service.createProject(principal(owner), { workspaceId, teamId, name: 'Bad dates', startAt: new Date('2032-05-01T00:00:00Z'), targetAt: new Date('2032-04-01T00:00:00Z') }), 'invalid_project_dates');
    await errorCode(service.createCycle(principal(owner), { workspaceId, teamId, name: 'Bad cycle', startAt: new Date('2032-05-01T00:00:00Z'), endAt: new Date('2032-04-01T00:00:00Z') }), 'invalid_cycle_dates');

    const project = await service.createProject(principal(owner), { workspaceId, teamId, name: 'Launch', status: 'in_progress' }) as { id: string };
    const otherProject = await service.createProject(principal(owner), { workspaceId, teamId: otherTeamId, name: 'Other' }) as { id: string };
    const firstCycle = await service.createCycle(principal(owner), { workspaceId, teamId, name: 'January', startAt: new Date('2032-01-01T00:00:00Z'), endAt: new Date('2032-02-01T00:00:00Z') }) as { id: string };
    await service.createCycle(principal(owner), { workspaceId, teamId, name: 'February', startAt: new Date('2032-02-01T00:00:00Z'), endAt: new Date('2032-03-01T00:00:00Z') });

    const grouping = await service.groupIssue(principal(owner), { workspaceId, teamId, issueId, projectId: project.id, cycleId: firstCycle.id, expectedVersion: 1 }) as { projectId: string; cycleId: string; version: number };
    assert.deepEqual({ projectId: grouping.projectId, cycleId: grouping.cycleId, version: grouping.version }, { projectId: project.id, cycleId: firstCycle.id, version: 2 });
    const projects = await service.listProjects(principal(owner), { workspaceId, teamId }) as Array<{ id: string; issueCount: number; completedIssueCount: number }>;
    assert.equal(projects.find((item) => item.id === project.id)?.issueCount, 1);
    assert.equal(projects.find((item) => item.id === project.id)?.completedIssueCount, 0);

    const cycles = await service.listCycles(principal(owner), { workspaceId, teamId }) as Array<{ id: string; issueCount: number }>;
    assert.equal(cycles.find((item) => item.id === firstCycle.id)?.issueCount, 1);

    await errorCode(service.groupIssue(principal(owner), { workspaceId, teamId, issueId, projectId: otherProject.id, expectedVersion: 2 }), 'project_not_found');
    await errorCode(service.groupIssue(principal(owner), { workspaceId, teamId, issueId: otherIssueId, projectId: project.id, expectedVersion: 1 }), 'issue_not_found');
    await errorCode(service.groupIssue(principal(owner), { workspaceId, teamId, issueId, projectId: foreignIssueId, expectedVersion: 2 }), 'project_not_found');
    await errorCode(service.groupIssue(principal(owner), { workspaceId, teamId, issueId, projectId: project.id, expectedVersion: 999 }), 'version_conflict');
    await errorCode(service.createCycle(principal(owner), { workspaceId, teamId, name: 'Overlap', startAt: new Date('2032-01-15T00:00:00Z'), endAt: new Date('2032-01-20T00:00:00Z') }), 'cycle_overlap');

    // Partial updates and unassigning
    const unassignedProject = await service.groupIssue(principal(owner), { workspaceId, teamId, issueId, projectId: null, expectedVersion: 2 }) as { projectId: string | null; cycleId: string | null; version: number };
    assert.deepEqual({ projectId: unassignedProject.projectId, cycleId: unassignedProject.cycleId, version: unassignedProject.version }, { projectId: null, cycleId: firstCycle.id, version: 3 });

    const unassignedCycle = await service.groupIssue(principal(owner), { workspaceId, teamId, issueId, cycleId: null, expectedVersion: 3 }) as { projectId: string | null; cycleId: string | null; version: number };
    assert.deepEqual({ projectId: unassignedCycle.projectId, cycleId: unassignedCycle.cycleId, version: unassignedCycle.version }, { projectId: null, cycleId: null, version: 4 });

    const raceStart = new Date('2032-04-01T00:00:00Z');
    const raceEnd = new Date('2032-05-01T00:00:00Z');
    const results = await Promise.allSettled([
      service.createCycle(principal(owner), { workspaceId, teamId, name: 'Race A', startAt: raceStart, endAt: raceEnd }),
      service.createCycle(principal(owner), { workspaceId, teamId, name: 'Race B', startAt: raceStart, endAt: raceEnd })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected' && rejected.reason instanceof ApiError && rejected.reason.code === 'cycle_overlap');
  } finally {
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('SET LOCAL session_replication_role = replica');
      await cleanup.query('DELETE FROM outbox_events WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM issue_activity_events WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM issues WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM projects WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM cycles WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM team_memberships WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM teams WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM workspace_memberships WHERE workspace_id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [allWorkspaces]);
      await cleanup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[owner, member, outsider]]);
      await cleanup.query('COMMIT');
    } catch (error) {
      await cleanup.query('ROLLBACK');
      throw error;
    } finally {
      cleanup.release();
    }
  }
});
