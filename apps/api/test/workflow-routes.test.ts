import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Principal } from '../src/auth/authenticator.js';
import { registerErrorHandler } from '../src/http/error-handler.js';
import { WorkflowDomainError } from '../src/workflows/workflow-domain.js';
import { registerWorkflowRoutes } from '../src/workflows/workflow-routes.js';
import type { WorkflowService } from '../src/workflows/workflow-service.js';

function createMockService(overrides: Partial<WorkflowService> = {}): WorkflowService {
  return {
    getWorkflowForPrincipal: async () => ({
      version: 5,
      statuses: [],
      transitions: [],
    }),
    listStatusesForPrincipal: async () => [],
    getStatusForPrincipal: async (_p, scope, id) => ({
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
    createStatusForPrincipal: async (_p, input) => ({
      status: {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        key: input.key,
        name: input.name,
        category: input.category,
        position: input.position ?? 0,
        isDefault: input.isDefault ?? false,
        isRetired: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      version: input.expectedVersion + 1,
    }),
    updateStatusForPrincipal: async (_p, input) => ({
      status: {
        id: input.statusId,
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        key: 'test',
        name: input.name ?? 'test',
        category: input.category ?? 'started',
        position: input.position ?? 1,
        isDefault: input.isDefault ?? false,
        isRetired: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      version: input.expectedVersion + 1,
    }),
    retireStatusForPrincipal: async (_p, input) => ({
      retiredStatusId: input.statusId,
      reassignedCount: 4,
      version: input.expectedVersion + 1,
    }),
    addTransitionForPrincipal: async (_p, input) => ({
      transition: {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        sourceStatusId: input.sourceStatusId,
        targetStatusId: input.targetStatusId,
        createdAt: new Date(),
      },
      version: input.expectedVersion + 1,
    }),
    deleteTransitionForPrincipal: async (_p, input) => ({
      version: input.expectedVersion + 1,
    }),
    ...overrides,
  };
}

function createTestApp(service: WorkflowService, principal?: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (principal) req.principal = principal;
    req.id = 'req-123';
    next();
  });
  const router = express.Router();
  registerWorkflowRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  return app;
}

test('WorkflowRoutes: GET /workflow returns 200 with data and ETag', async () => {
  const principal = { userId: randomUUID(), sessionId: 's1' };
  const app = createTestApp(createMockService(), principal);
  const server = app.listen(0);
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${randomUUID()}/teams/${randomUUID()}/workflow`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ETag'), 'W/"5"');
    const body = await res.json() as any;
    assert.equal(body.data.version, 5);
  } finally {
    server.close();
  }
});

test('WorkflowRoutes: rejects unauthenticated requests with 401', async () => {
  const app = createTestApp(createMockService(), undefined); // No principal
  const server = app.listen(0);
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${randomUUID()}/teams/${randomUUID()}/workflow`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('WorkflowRoutes: POST /statuses validates input and returns 201 with version header', async () => {
  const principal = { userId: randomUUID(), sessionId: 's1' };
  const app = createTestApp(createMockService(), principal);
  const server = app.listen(0);
  const port = (server.address() as any).port;

  try {
    // Missing required fields -> 400
    const badRes = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${randomUUID()}/teams/${randomUUID()}/workflow/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test' }),
    });
    assert.equal(badRes.status, 400);

    // Valid create
    const goodRes = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${randomUUID()}/teams/${randomUUID()}/workflow/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'in_review',
        name: 'In Review',
        category: 'started',
        expectedVersion: 1,
      }),
    });
    assert.equal(goodRes.status, 201);
    assert.equal(goodRes.headers.get('ETag'), 'W/"2"');
    const body = await goodRes.json() as any;
    assert.equal(body.data.status.key, 'in_review');
    assert.equal(body.data.version, 2);
  } finally {
    server.close();
  }
});

test('WorkflowRoutes: maps domain errors to appropriate HTTP status codes', async () => {
  const principal = { userId: randomUUID(), sessionId: 's1' };
  const errorService = createMockService({
    createStatusForPrincipal: async () => {
      throw new WorkflowDomainError('workflow_version_conflict', 'Version mismatch');
    },
    retireStatusForPrincipal: async () => {
      throw new WorkflowDomainError('workflow_forbidden', 'Denied');
    },
  });

  const app = createTestApp(errorService, principal);
  const server = app.listen(0);
  const port = (server.address() as any).port;

  try {
    const conflictRes = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${randomUUID()}/teams/${randomUUID()}/workflow/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'qa',
        name: 'QA',
        category: 'started',
        expectedVersion: 1,
      }),
    });
    assert.equal(conflictRes.status, 409);

    const forbiddenRes = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${randomUUID()}/teams/${randomUUID()}/workflow/statuses/${randomUUID()}/retire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetStatusId: randomUUID(),
        expectedVersion: 1,
      }),
    });
    assert.equal(forbiddenRes.status, 403);
  } finally {
    server.close();
  }
});
