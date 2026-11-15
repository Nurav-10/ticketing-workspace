import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import test from 'node:test';
import { registerErrorHandler } from '../src/http/error-handler.js';
import { registerIssueSearchRoutes } from '../src/search/issue-search-routes.js';
import { IssueSearchDomainError } from '../src/search/issue-search-domain.js';
import type { IssueSearchApplicationService } from '../src/search/issue-search-service.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const actorId = '49a03ed2-7eb3-4c00-a8e1-519c70306427';

test('issue search uses a POST body, active-default filter, verified principal and no-store response', async () => {
  const calls: unknown[] = [];
  const service = {
    searchForPrincipal: async (...args: unknown[]) => { calls.push(args); return { items: [] }; },
  } as unknown as IssueSearchApplicationService;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.id = 'issue-search-http-test';
    request.principal = { userId: actorId, sessionId: 'session' };
    next();
  });
  const router = express.Router();
  registerIssueSearchRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues/search`;
  try {
    const injected = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchTerm: 'sensitive term', actorUserId: 'attacker' }),
    });
    assert.equal(injected.status, 400);
    assert.equal(calls.length, 0);

    const queryString = await fetch(`${url}?searchTerm=sensitive-term`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchTerm: 'sensitive term' }),
    });
    assert.equal(queryString.status, 400);
    assert.equal(calls.length, 0);

    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchTerm: 'sensitive term' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(new URL(response.url).search, '');
    assert.equal((calls[0]?.[0] as { userId: string }).userId, actorId);
    assert.deepEqual(calls[0]?.[1], { workspaceId, teamId, searchTerm: 'sensitive term' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('issue search rejects anonymous requests before calling the service', async () => {
  let called = false;
  const service = { searchForPrincipal: async () => { called = true; return { items: [] }; } } as unknown as IssueSearchApplicationService;
  const app = express();
  app.use((request, _response, next) => { request.id = 'issue-search-anonymous-test'; next(); });
  const router = express.Router();
  registerIssueSearchRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchTerm: 'secret' }),
    });
    assert.equal(response.status, 401);
    assert.equal(called, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('issue search maps a stale generation cursor to a recoverable conflict', async () => {
  const service = {
    searchForPrincipal: async () => { throw new IssueSearchDomainError('issue_search_cursor_stale', 'Search results changed'); },
  } as unknown as IssueSearchApplicationService;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.id = 'issue-search-stale-test';
    request.principal = { userId: actorId, sessionId: 'session' };
    next();
  });
  const router = express.Router();
  registerIssueSearchRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchTerm: 'changed', cursor: 'signed-stale-token' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'stale_cursor');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
