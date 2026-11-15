import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../src/auth/authenticator.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { WorkflowDomainError } from '../src/workflows/workflow-domain.js';
import type { WorkflowRepository } from '../src/workflows/workflow-repository.js';
import { WorkflowApplicationService } from '../src/workflows/workflow-service.js';

function createMockPrisma(options: {
  membershipRole?: 'owner' | 'admin' | 'member' | null;
  teamVisibility?: 'workspace' | 'private' | null;
  isPrivateTeamMember?: boolean;
}) {
  return {
    workspaceMembership: {
      findFirst: async ({ where }: any) => {
        if (!options.membershipRole) return null;
        return { role: options.membershipRole };
      },
    },
    team: {
      findFirst: async ({ where }: any) => {
        if (!options.teamVisibility) return null;
        return { visibility: options.teamVisibility };
      },
    },
    teamMembership: {
      findFirst: async ({ where }: any) => {
        if (!options.isPrivateTeamMember) return null;
        return { userId: where.userId };
      },
    },
  } as unknown as PrismaClient;
}

function createMockRepo(): WorkflowRepository {
  return {
    getWorkflow: async (scope) => ({
      version: 1,
      statuses: [],
      transitions: [],
    }),
    listStatuses: async () => [],
    getStatus: async (scope, id) => ({
      id,
      workspaceId: scope.workspaceId,
      teamId: scope.teamId,
      key: 'backlog',
      name: 'Backlog',
      category: 'backlog',
      position: 0,
      isDefault: true,
      isRetired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getStatusByKey: async () => null,
    createStatus: async (cmd) => ({
      status: {
        id: randomUUID(),
        workspaceId: cmd.workspaceId,
        teamId: cmd.teamId,
        key: cmd.key,
        name: cmd.name,
        category: cmd.category,
        position: cmd.position ?? 0,
        isDefault: cmd.isDefault,
        isRetired: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      version: cmd.expectedVersion + 1,
    }),
    updateStatus: async (cmd) => ({
      status: {
        id: cmd.statusId,
        workspaceId: cmd.workspaceId,
        teamId: cmd.teamId,
        key: 'test',
        name: cmd.changes.name ?? 'test',
        category: cmd.changes.category ?? 'backlog',
        position: cmd.changes.position ?? 0,
        isDefault: cmd.changes.isDefault ?? false,
        isRetired: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      version: cmd.expectedVersion + 1,
    }),
    retireStatus: async (cmd) => ({
      retiredStatusId: cmd.statusId,
      reassignedCount: 2,
      version: cmd.expectedVersion + 1,
    }),
    addTransition: async (cmd) => ({
      transition: {
        id: randomUUID(),
        workspaceId: cmd.workspaceId,
        teamId: cmd.teamId,
        sourceStatusId: cmd.sourceStatusId,
        targetStatusId: cmd.targetStatusId,
        createdAt: new Date(),
      },
      version: cmd.expectedVersion + 1,
    }),
    deleteTransition: async (cmd) => ({
      version: cmd.expectedVersion + 1,
    }),
  };
}

test('WorkflowService: requires verified principal', async () => {
  const service = new WorkflowApplicationService(createMockRepo(), createMockPrisma({}));
  const unverified = { userId: 'not-a-uuid', sessionId: 's1' } as Principal;

  await assert.rejects(
    service.getWorkflowForPrincipal(unverified, { workspaceId: randomUUID(), teamId: randomUUID() }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_forbidden',
  );
});

test('WorkflowService: requires workspace membership to read', async () => {
  const service = new WorkflowApplicationService(createMockRepo(), createMockPrisma({ membershipRole: null }));
  const principal: Principal = { userId: randomUUID(), sessionId: 's1' };

  await assert.rejects(
    service.getWorkflowForPrincipal(principal, { workspaceId: randomUUID(), teamId: randomUUID() }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_not_found',
  );
});

test('WorkflowService: denies private team read if not a private team member', async () => {
  const service = new WorkflowApplicationService(createMockRepo(), createMockPrisma({
    membershipRole: 'admin',
    teamVisibility: 'private',
    isPrivateTeamMember: false,
  }));
  const principal: Principal = { userId: randomUUID(), sessionId: 's1' };

  await assert.rejects(
    service.getWorkflowForPrincipal(principal, { workspaceId: randomUUID(), teamId: randomUUID() }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_not_found',
  );
});

test('WorkflowService: allows team members to read workflow', async () => {
  const service = new WorkflowApplicationService(createMockRepo(), createMockPrisma({
    membershipRole: 'member',
    teamVisibility: 'workspace',
  }));
  const principal: Principal = { userId: randomUUID(), sessionId: 's1' };

  const config = await service.getWorkflowForPrincipal(principal, { workspaceId: randomUUID(), teamId: randomUUID() });
  assert.equal(config.version, 1);
});

test('WorkflowService: requires team administrator role for status mutation', async () => {
  const memberService = new WorkflowApplicationService(createMockRepo(), createMockPrisma({
    membershipRole: 'member',
    teamVisibility: 'workspace',
  }));
  const principal: Principal = { userId: randomUUID(), sessionId: 's1' };
  const workspaceId = randomUUID();
  const teamId = randomUUID();

  await assert.rejects(
    memberService.createStatusForPrincipal(principal, {
      workspaceId,
      teamId,
      key: 'test',
      name: 'Test',
      category: 'started',
      expectedVersion: 1,
    }),
    (e: unknown) => e instanceof WorkflowDomainError && e.code === 'workflow_forbidden',
  );

  const adminService = new WorkflowApplicationService(createMockRepo(), createMockPrisma({
    membershipRole: 'admin',
    teamVisibility: 'workspace',
  }));

  const created = await adminService.createStatusForPrincipal(principal, {
    workspaceId,
    teamId,
    key: 'test',
    name: 'Test',
    category: 'started',
    expectedVersion: 1,
  });
  assert.equal(created.version, 2);
  assert.equal(created.status.name, 'Test');
});

test('WorkflowService: allows admin to retire and reassign status', async () => {
  const adminService = new WorkflowApplicationService(createMockRepo(), createMockPrisma({
    membershipRole: 'owner',
    teamVisibility: 'workspace',
  }));
  const principal: Principal = { userId: randomUUID(), sessionId: 's1' };

  const res = await adminService.retireStatusForPrincipal(principal, {
    workspaceId: randomUUID(),
    teamId: randomUUID(),
    statusId: randomUUID(),
    targetStatusId: randomUUID(),
    expectedVersion: 1,
  });

  assert.equal(res.reassignedCount, 2);
  assert.equal(res.version, 2);
});
