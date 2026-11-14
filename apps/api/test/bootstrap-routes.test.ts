import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { registerBootstrapRoutes, BOOTSTRAP_TRANSACTION_COOKIE_NAME } from '../src/bootstrap/bootstrap-routes.js';

async function listen(app: express.Express): Promise<{ url: string; close(): Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('bootstrap operator form uses same-origin POST, injected limiting, and secure transaction cookie', async () => {
  const secret = Buffer.alloc(32, 11).toString('base64url');
  const calls: unknown[] = [];
  let limited = 0;
  const app = express();
  app.use((request, response, next) => { request.id = 'bootstrap-request'; next(); });
  const router = express.Router();
  registerBootstrapRoutes(router, {
    beginBootstrapLogin: async (provided) => {
      calls.push(provided);
      return { transactionHandle: 'tx-handle', authorizationUrl: 'https://issuer.example/authorize?state=opaque' };
    },
  }, {
    publicOrigin: 'https://app.example',
    rateLimit: (_request, _response, next) => { limited++; next(); },
  });
  app.use('/api/v1/bootstrap', router);
  const server = await listen(app);
  try {
    const page = await fetch(`${server.url}/api/v1/bootstrap/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /type="password"/);
    assert.equal(page.headers.get('cache-control'), 'no-store');

    const wrongOrigin = await fetch(`${server.url}/api/v1/bootstrap/`, {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `operatorSecret=${secret}`,
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(calls.length, 0);
    assert.equal(limited, 0);

    const started = await fetch(`${server.url}/api/v1/bootstrap/`, {
      method: 'POST', redirect: 'manual', headers: { origin: 'https://app.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `operatorSecret=${secret}`,
    });
    assert.equal(started.status, 303);
    assert.deepEqual(calls, [secret]);
    assert.equal(started.headers.get('location'), 'https://issuer.example/authorize?state=opaque');
    const cookie = started.headers.get('set-cookie') ?? '';
    assert.ok(cookie.startsWith(`${BOOTSTRAP_TRANSACTION_COOKIE_NAME}=tx-handle`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.equal(started.headers.get('cache-control'), 'no-store');
    assert.equal(started.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(limited, 1);
    assert.doesNotMatch(started.headers.get('location') ?? '', new RegExp(secret));
    assert.doesNotMatch(await started.text(), new RegExp(secret));
  } finally { await server.close(); }
});

test('bootstrap form rejects query secrets and malformed bodies without invoking flow', async () => {
  let called = false;
  const app = express();
  app.use((request, _response, next) => { request.id = 'bootstrap-invalid'; next(); });
  const router = express.Router();
  registerBootstrapRoutes(router, { beginBootstrapLogin: async () => { called = true; throw new Error('unexpected'); } }, {
    publicOrigin: 'https://app.example', rateLimit: (_request, _response, next) => next(),
  });
  app.use('/bootstrap', router);
  const server = await listen(app);
  try {
    const query = await fetch(`${server.url}/bootstrap/?operatorSecret=not-in-url`, {
      method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'operatorSecret=secret',
    });
    assert.equal(query.status, 400);
    const malformed = await fetch(`${server.url}/bootstrap/`, {
      method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'operatorSecret=one&operatorSecret=two',
    });
    assert.equal(malformed.status, 400);
    assert.equal(called, false);
  } finally { await server.close(); }
});
