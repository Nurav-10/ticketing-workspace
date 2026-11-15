import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Principal } from '../src/auth/authenticator.js';
import { WorkflowDomainError } from '../src/workflows/workflow-domain.js';
import { WorkflowApplicationService } from '../src/workflows/workflow-service.js';
import { PrismaWorkflowRepository } from '../src/workflows/prisma-workflow-repository.js';
import { pool, prisma } from './test-database.js';

const repo = new PrismaWorkflowRepository(prisma);
const service = new WorkflowApplicationService(repo, prisma);

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO users(id, provider_subject, email, display_name) VALUES ($1, $2, $3, $4)',
    [id, `workflow-integration:${label}:${id}`, `${id}@example.test`, `Workflow ${label}`],
  );
  return id;
}

function principal(userId: string): Principal {
  return { userId, sessionId: `workflow-integration:${userId}` };
}

test('PostgreSQL workflow slice enforces canonical defaults, admin authorization, optimistic concurrency, and atomic reassignment', async () => {
  const users = {
    owner: await createUser('owner'),
    member: await createUser('member'),
    outsider: await createUser('outsider'),
  };

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const teams = { public: randomUUID(), private: randomUUID() };
  const keys = { public: 'WF1', private: 'WF2' };

  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(
      'INSERT INTO workspaces(id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)',
      [workspaceId, 'Workflow test workspace', `wf-${workspaceId.slice(0, 8)}`,
       otherWorkspaceId, 'Other workspace', `wf-other-${otherWorkspaceId.slice(0, 8)}`],
    );
    await setup.query(
      `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES
        ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')`,
      [workspaceId, users.owner, users.member, otherWorkspaceId, users.outsider],
    );
    // Inserting teams automatically triggers default workflow status and transition seeding via database trigger!
    await setup.query(
      `INSERT INTO teams(id, workspace_id, name, key, visibility) VALUES
        ($1, $2, 'Public workflow team', $3, 'workspace'),
        ($4, $2, 'Private workflow team', $5, 'private')`,
      [teams.public, workspaceId, keys.public, teams.private, keys.private],
    );
    // Only owner is in private team
    await setup.query(
      'INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1, $2, $3)',
      [workspaceId, teams.private, users.owner],
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally {
    setup.release();
  }

  // 1. Verify default seeded statuses and transitions for public team
  const initialWorkflow = await service.getWorkflowForPrincipal(
    principal(users.member),
    { workspaceId, teamId: teams.public },
  );
  assert.equal(initialWorkflow.version, 1);
  assert.equal(initialWorkflow.statuses.length, 5);
  const statusKeys = initialWorkflow.statuses.map((s) => s.key).sort();
  assert.deepEqual(statusKeys, ['backlog', 'canceled', 'done', 'in_progress', 'todo']);

  const backlogStatus = initialWorkflow.statuses.find((s) => s.key === 'backlog');
  assert.ok(backlogStatus);
  assert.equal(backlogStatus.isDefault, true);
  assert.equal(backlogStatus.category, 'backlog');

  // Verify transitions seeded
  assert.ok(initialWorkflow.transitions.length > 0);

  // 2. Private team isolation
  // Outsider cannot access private team workflow -> 404
  await assert.rejects(
    service.getWorkflowForPrincipal(principal(users.outsider), { workspaceId, teamId: teams.private }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_not_found',
  );

  // Member (not in private team) cannot access private team workflow -> 404
  await assert.rejects(
    service.getWorkflowForPrincipal(principal(users.member), { workspaceId, teamId: teams.private }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_not_found',
  );

  // Owner (in private team) can access private team workflow
  const privateWf = await service.getWorkflowForPrincipal(
    principal(users.owner),
    { workspaceId, teamId: teams.private },
  );
  assert.equal(privateWf.version, 1);

  // 3. Authorization for mutations
  // Member cannot create a status -> 403
  await assert.rejects(
    service.createStatusForPrincipal(principal(users.member), {
      workspaceId,
      teamId: teams.public,
      key: 'in_qa',
      name: 'In QA',
      category: 'started',
      expectedVersion: 1,
    }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_forbidden',
  );

  // Owner creates a new status
  const created = await service.createStatusForPrincipal(principal(users.owner), {
    workspaceId,
    teamId: teams.public,
    key: 'in_qa',
    name: 'In QA',
    category: 'started',
    position: 3,
    expectedVersion: 1,
  });
  assert.equal(created.version, 2);
  assert.equal(created.status.key, 'in_qa');
  assert.equal(created.status.name, 'In QA');

  // Duplicate key is rejected with conflict (409)
  await assert.rejects(
    service.createStatusForPrincipal(principal(users.owner), {
      workspaceId,
      teamId: teams.public,
      key: 'in_qa',
      name: 'Duplicate QA',
      category: 'started',
      expectedVersion: 2,
    }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_key_exists',
  );

  // Stale expectedVersion is rejected with 409
  await assert.rejects(
    service.updateStatusForPrincipal(principal(users.owner), {
      workspaceId,
      teamId: teams.public,
      statusId: created.status.id,
      name: 'QA Testing',
      expectedVersion: 1, // Stale! Current version is 2
    }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_version_conflict',
  );

  // Successful update increments version
  const updated = await service.updateStatusForPrincipal(principal(users.owner), {
    workspaceId,
    teamId: teams.public,
    statusId: created.status.id,
    name: 'QA Testing',
    expectedVersion: 2,
  });
  assert.equal(updated.version, 3);
  assert.equal(updated.status.name, 'QA Testing');

  // 4. Transition edges
  const inProgressStatus = initialWorkflow.statuses.find((s) => s.key === 'in_progress')!;
  const doneStatus = initialWorkflow.statuses.find((s) => s.key === 'done')!;

  // Add edge: in_progress -> in_qa
  const edge = await service.addTransitionForPrincipal(principal(users.owner), {
    workspaceId,
    teamId: teams.public,
    sourceStatusId: inProgressStatus.id,
    targetStatusId: created.status.id,
    expectedVersion: 3,
  });
  assert.equal(edge.version, 4);

  // Verify transition exists via port
  const canMove = await repo.canTransition(
    { workspaceId, teamId: teams.public },
    inProgressStatus.id,
    created.status.id,
  );
  assert.equal(canMove, true);

  // Add edge: in_qa -> done
  await service.addTransitionForPrincipal(principal(users.owner), {
    workspaceId,
    teamId: teams.public,
    sourceStatusId: created.status.id,
    targetStatusId: doneStatus.id,
    expectedVersion: 4,
  });

  // 5. Create issues assigned to 'in_qa' status
  const issueId = randomUUID();
  await pool.query(
    `INSERT INTO issues(id, workspace_id, team_id, issue_number, title, status, workflow_status_id, created_by_user_id, version)
     VALUES ($1, $2, $3, 101, 'Testing issue in QA', 'in_progress', $4, $5, 1)`,
    [issueId, workspaceId, teams.public, created.status.id, users.owner],
  );

  // 6. Atomic retirement and reassignment
  // Cannot retire default status
  await assert.rejects(
    service.retireStatusForPrincipal(principal(users.owner), {
      workspaceId,
      teamId: teams.public,
      statusId: backlogStatus.id,
      targetStatusId: doneStatus.id,
      expectedVersion: 5,
    }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_default_invariant_violated',
  );

  // Retire 'in_qa', reassigning issues to 'done'
  const retired = await service.retireStatusForPrincipal(principal(users.owner), {
    workspaceId,
    teamId: teams.public,
    statusId: created.status.id,
    targetStatusId: doneStatus.id,
    expectedVersion: 5,
  });

  assert.equal(retired.version, 6);
  assert.equal(retired.reassignedCount, 1);
  assert.equal(retired.retiredStatusId, created.status.id);

  // Verify issue was reassigned in database
  const issueCheck = await pool.query(
    'SELECT workflow_status_id::text, version FROM issues WHERE id = $1',
    [issueId],
  );
  assert.equal(issueCheck.rows[0].workflow_status_id, doneStatus.id);
  assert.equal(issueCheck.rows[0].version, 2);

  // Verify issue activity was recorded
  const activityCheck = await pool.query(
    'SELECT event_kind::text, metadata FROM issue_activity_events WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1',
    [issueId],
  );
  assert.equal(activityCheck.rows[0].event_kind, 'status_changed');
  assert.equal(activityCheck.rows[0].metadata.statusAfter, doneStatus.key);

  // Verify transitions connecting to/from retired status were deleted
  const edgeCheck = await pool.query(
    'SELECT count(*)::int AS count FROM workflow_transitions WHERE source_status_id = $1 OR target_status_id = $1',
    [created.status.id],
  );
  assert.equal(edgeCheck.rows[0].count, 0);

  // Verify status is marked retired
  const statusCheck = await service.getStatusForPrincipal(
    principal(users.owner),
    { workspaceId, teamId: teams.public },
    created.status.id,
  );
  assert.equal(statusCheck.isRetired, true);

  // Cannot transition to a retired status
  await assert.rejects(
    service.addTransitionForPrincipal(principal(users.owner), {
      workspaceId,
      teamId: teams.public,
      sourceStatusId: doneStatus.id,
      targetStatusId: created.status.id,
      expectedVersion: 6,
    }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_status_retired',
  );
});
