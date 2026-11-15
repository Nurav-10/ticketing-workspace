import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { registerErrorHandler } from '../src/http/error-handler.js';
import { registerPlanningRoutes } from '../src/planning/planning-routes.js';
import type { PlanningService } from '../src/planning/planning-service.js';

const workspaceId = '5d3f874c-e669-41ee-961d-39289ae5c83f';
const teamId = '2c684b77-6b98-46b8-9c96-681b59109f08';
const issueId = 'd2ad6af7-3bbb-4f38-988d-164311065180';
const actorId = '813fc1e0-1c36-4cf6-bccd-88bc83943a07';

test('planning routes reject injected fields and require a versioned grouping command', async () => {
  const calls: Array<{ method: string; principal: unknown; input: unknown }> = [];
  const service: PlanningService = {
    listProjects: async (principal, input) => { calls.push({ method: 'listProjects', principal, input }); return []; },
    createProject: async (principal, input) => { calls.push({ method: 'createProject', principal, input }); return { id: teamId }; },
    listCycles: async (principal, input) => { calls.push({ method: 'listCycles', principal, input }); return []; },
    createCycle: async (principal, input) => { calls.push({ method: 'createCycle', principal, input }); return { id: teamId }; },
    groupIssue: async (principal, input) => { calls.push({ method: 'groupIssue', principal, input }); return { id: issueId, version: 2 }; }
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.id = 'planning-http-test'; request.principal = { userId: actorId, sessionId: 'test-session' }; next(); });
  const router = express.Router();
  registerPlanningRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}`;
  try {
    const listProj = await fetch(`${root}/projects`, { method: 'GET' });
    assert.equal(listProj.status, 200);
    assert.equal(listProj.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls[0]!.input, { workspaceId, teamId });

    const listCyc = await fetch(`${root}/cycles`, { method: 'GET' });
    assert.equal(listCyc.status, 200);
    assert.deepEqual(calls[1]!.input, { workspaceId, teamId });

    const injected = await fetch(`${root}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Planning', actorUserId: 'attacker' }) });
    assert.equal(injected.status, 400);

    const created = await fetch(`${root}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Planning' }) });
    assert.equal(created.status, 201);
    assert.equal((calls[2]!.principal as { userId: string }).userId, actorId);

    const invalidZone = await fetch(`${root}/cycles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cycle', startAt: '2034-01-01T10:00:00', endAt: '2034-01-02T10:00:00Z' }) });
    assert.equal(invalidZone.status, 400);

    const createdCycle = await fetch(`${root}/cycles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cycle', startAt: '2034-01-01T10:00:00Z', endAt: '2034-01-02T10:00:00Z' }) });
    assert.equal(createdCycle.status, 201);

    const unversioned = await fetch(`${root}/issues/${issueId}/grouping`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: teamId }) });
    assert.equal(unversioned.status, 400);

    const versionMismatch = await fetch(`${root}/issues/${issueId}/grouping`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': '"1"' }, body: JSON.stringify({ projectId: teamId, expectedVersion: 2 }) });
    assert.equal(versionMismatch.status, 400);

    const grouped = await fetch(`${root}/issues/${issueId}/grouping`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': '"1"' }, body: JSON.stringify({ projectId: teamId }) });
    assert.equal(grouped.status, 200);
    assert.equal(grouped.headers.get('etag'), '"2"');
    assert.deepEqual(calls[4]!.input, { workspaceId, teamId, issueId, projectId: teamId, expectedVersion: 1 });

    const unassign = await fetch(`${root}/issues/${issueId}/grouping`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: null, cycleId: null, expectedVersion: 2 }) });
    assert.equal(unassign.status, 200);
    assert.deepEqual(calls[5]!.input, { workspaceId, teamId, issueId, projectId: null, cycleId: null, expectedVersion: 2 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
