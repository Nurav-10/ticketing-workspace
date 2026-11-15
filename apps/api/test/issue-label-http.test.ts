import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import test from 'node:test';
import { registerErrorHandler } from '../src/http/error-handler.js';
import { registerIssueLabelRoutes } from '../src/labels/issue-label-routes.js';
import type { IssueLabelApplicationService } from '../src/labels/issue-label-service.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const issueId = '24fba2dd-8131-4c53-a8b4-07ab988da002';
const actorId = '49a03ed2-7eb3-4c00-a8e1-519c70306427';
const labelId = '6e3cdf0f-4019-4f37-a19e-61703eec7c95';

test('issue-label route uses the authenticated principal and requires a strong expected-version precondition', async () => {
  const calls: unknown[] = [];
  const service = {
    getForPrincipal: async (...args: unknown[]) => {
      calls.push(args);
      return { workspaceId, teamId, issueId, version: 2, labelIds: [labelId] };
    },
    replaceForPrincipal: async (...args: unknown[]) => {
      calls.push(args);
      return { workspaceId, teamId, issueId, version: 2, labelIds: [labelId] };
    },
  } as unknown as IssueLabelApplicationService;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.id = 'issue-label-http-test';
    request.principal = { userId: actorId, sessionId: 'session' };
    next();
  });
  const router = express.Router();
  registerIssueLabelRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues/${issueId}/labels`;
  try {
    const invalid = await fetch(url, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': 'W/"1"' },
      body: JSON.stringify({ labelIds: [labelId] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 0);

    const response = await fetch(url, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"1"' },
      body: JSON.stringify({ labelIds: [labelId] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), '"2"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((calls[0]?.[0] as { userId: string }).userId, actorId);
    assert.equal((calls[0]?.[1] as { expectedVersion: number }).expectedVersion, 1);
    const loaded = await fetch(url);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.headers.get('etag'), '"2"');
    assert.deepEqual((await loaded.json() as { data: { labelIds: string[] } }).data.labelIds, [labelId]);
    assert.equal((calls[1]?.[0] as { userId: string }).userId, actorId);
    assert.equal((await fetch(`${url}?other=1`)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('issue-label route rejects anonymous requests before calling the service', async () => {
  let called = false;
  const service = { replaceForPrincipal: async () => { called = true; return {}; } } as unknown as IssueLabelApplicationService;
  const app = express();
  app.use((request, _response, next) => { request.id = 'issue-label-anonymous-test'; next(); });
  const router = express.Router();
  registerIssueLabelRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues/${issueId}/labels`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labelIds: [], expectedVersion: 1 }),
    });
    assert.equal(response.status, 401);
    assert.equal(called, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
