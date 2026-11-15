import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import test from 'node:test';
import { registerErrorHandler } from '../src/http/error-handler.js';
import { registerLabelRoutes } from '../src/labels/label-routes.js';
import type { Label } from '../src/labels/label-domain.js';
import type { LabelApplicationService } from '../src/labels/label-service.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const labelId = '24fba2dd-8131-4c53-a8b4-07ab988da002';
const actorId = '49a03ed2-7eb3-4c00-a8e1-519c70306427';
const label: Label = {
  id: labelId, workspaceId, teamId, name: 'Needs QA', normalizedName: 'needs qa', color: '#6b7280', version: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};

test('label CRUD routes pass the verified principal, enforce versions, and return no-store responses', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    listForPrincipal: async (...args: unknown[]) => { calls.push({ method: 'list', args }); return { items: [label], nextCursor: null }; },
    createForPrincipal: async (...args: unknown[]) => { calls.push({ method: 'create', args }); return label; },
    updateForPrincipal: async (...args: unknown[]) => { calls.push({ method: 'update', args }); return { ...label, version: 2 }; },
    deleteForPrincipal: async (...args: unknown[]) => { calls.push({ method: 'delete', args }); },
  } as unknown as LabelApplicationService;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.id = 'label-http-test';
    request.principal = { userId: actorId, sessionId: 'session' };
    next();
  });
  const router = express.Router();
  registerLabelRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/labels`;
  try {
    const listed = await fetch(root);
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.equal(calls[0]?.method, 'list');
    assert.equal((calls[0]?.args[0] as { userId: string }).userId, actorId);
    const listBody = await listed.json() as { data: Label[]; nextCursor: string | null };
    assert.deepEqual(listBody.data.map((item) => item.id), [labelId]);
    assert.equal(listBody.nextCursor, null);

    for (const suffix of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?unknown=1']) {
      const badQuery = await fetch(`${root}${suffix}`);
      assert.equal(badQuery.status, 400);
    }
    assert.equal(calls.length, 1);

    const injected = await fetch(root, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Needs QA', actorUserId: 'attacker' }),
    });
    assert.equal(injected.status, 400);
    assert.equal(calls.length, 1);

    const created = await fetch(root, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Needs QA' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('etag'), '"1"');

    const updated = await fetch(`${root}/${labelId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': '"1"' },
      body: JSON.stringify({ color: '#AABBCC' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.headers.get('etag'), '"2"');
    assert.equal((calls[2]?.args[1] as { expectedVersion: number }).expectedVersion, 1);

    const weak = await fetch(`${root}/${labelId}`, {
      method: 'DELETE', headers: { 'if-match': 'W/"2"' },
    });
    assert.equal(weak.status, 400);
    const deleted = await fetch(`${root}/${labelId}`, { method: 'DELETE', headers: { 'if-match': '"2"' } });
    assert.equal(deleted.status, 204);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('label routes reject anonymous requests before calling the service', async () => {
  let called = false;
  const service = { listForPrincipal: async () => { called = true; return []; } } as unknown as LabelApplicationService;
  const app = express();
  app.use((request, _response, next) => { request.id = 'label-anonymous-test'; next(); });
  const router = express.Router();
  registerLabelRoutes(router, service);
  app.use('/api/v1', router);
  registerErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/labels`);
    assert.equal(response.status, 401);
    assert.equal(called, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
