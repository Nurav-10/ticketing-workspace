import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerIssueRoutes } from '../src/issues/issue-routes.js';
import { registerErrorHandler } from '../src/http/error-handler.js';
import type { IssueService } from '../src/issues/issue-service.js';
import type { IssueSummary } from '../src/issues/issue-domain.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const issueId = '24fba2dd-8131-4c53-a8b4-07ab988da002';
const actorId = '49a03ed2-7eb3-4c00-a8e1-519c70306427';
const issue: IssueSummary = {
  id: issueId, workspaceId, teamId, issueNumber: 1, key: 'ENG-1', title: 'Example',
  description: null, status: 'backlog', priority: 'none', assigneeUserId: null, assignee: null,
  createdByUserId: actorId, version: 1, createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'), archivedAt: null,
};

test('issue routes use the authenticated principal, reject injected fields, and require strong edit versions', async () => {
  const calls: unknown[] = [];
  const service: IssueService = {
    createForPrincipal: async (principal, input) => { calls.push({ principal, input }); return issue; },
    listForPrincipal: async () => ({ items: [] }),
    getForPrincipal: async () => ({ issue, activity: [] }),
    updateForPrincipal: async (principal, input) => { calls.push({ principal, input }); return { ...issue, version: 2 }; },
    transitionForPrincipal: async () => issue,
    archiveForPrincipal: async () => issue,
    restoreForPrincipal: async () => issue,
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.id = 'issue-http-test'; request.principal = { userId: actorId, sessionId: 'session' }; next(); });
  const router = express.Router();
  registerIssueRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues`;
  try {
    const injected = await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' }, body: JSON.stringify({ title: 'Example', actorUserId: 'attacker' }) });
    assert.equal(injected.status, 400);
    assert.equal(calls.length, 0);
    const created = await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' }, body: JSON.stringify({ title: 'Example' }) });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('etag'), '"1"');
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal((await created.json() as { data: IssueSummary }).data.assignee, null);
    assert.equal((calls[0] as { principal: { userId: string } }).principal.userId, actorId);
    const weak = await fetch(`${root}/${issueId}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': 'W/"1"' }, body: JSON.stringify({ title: 'Changed' }) });
    assert.equal(weak.status, 400);
    const updated = await fetch(`${root}/${issueId}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': '"1"' }, body: JSON.stringify({ title: 'Changed' }) });
    assert.equal(updated.status, 200);
    assert.equal(updated.headers.get('etag'), '"2"');
    assert.equal(updated.headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('issue routes reject anonymous requests before calling the service', async () => {
  let called = false;
  const service = {
    listForPrincipal: async () => { called = true; return { items: [] }; },
  } as unknown as IssueService;
  const app = express();
  app.use((request, _response, next) => { request.id = 'anonymous-test'; next(); });
  const router = express.Router();
  registerIssueRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues`);
    assert.equal(response.status, 401);
    assert.equal(called, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
