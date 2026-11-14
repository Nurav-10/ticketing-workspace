import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerErrorHandler } from '../src/http/error-handler.js';
import { registerIssueAssigneeRoutes, type IssueAssigneeService } from '../src/issues/issue-assignees.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const actorId = '49a03ed2-7eb3-4c00-a8e1-519c70306427';

test('assignee-options route requires strict scoped UUIDs and returns only its service allowlist', async () => {
  const calls: unknown[] = [];
  const service: IssueAssigneeService = {
    listForPrincipal: async (principal, query) => {
      calls.push({ principal, query });
      return { items: [{ id: actorId, displayName: 'Example User' }] };
    },
  };
  const app = express();
  app.use((request, _response, next) => { request.id = 'issue-assignees-test'; request.principal = { userId: actorId, sessionId: 'session' }; next(); });
  const router = express.Router();
  registerIssueAssigneeRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/assignee-options`;
  try {
    const invalid = await fetch(root.replace(workspaceId, 'not-a-uuid'));
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 0);

    const tooMany = await fetch(`${root}?limit=101`);
    assert.equal(tooMany.status, 400);
    assert.equal(calls.length, 0);

    const response = await fetch(root);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { data: { items: [{ id: actorId, displayName: 'Example User' }] } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      principal: { userId: actorId, sessionId: 'session' },
      query: { workspaceId, teamId },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
