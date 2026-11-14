import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  ApiMetrics,
  createHttpMetricsMiddleware,
  createMetricsRouter,
} from '../src/observability/metrics.js';

async function listen(app: express.Express): Promise<{ url: string; close(): Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('HTTP metrics use bounded labels and omit request paths, query values, and headers', async () => {
  let now = 1_000;
  const metrics = new ApiMetrics(() => now);
  const app = express();
  app.use(createHttpMetricsMiddleware(metrics));
  app.get('/api/v1/private/:accountId', (_request, response) => {
    now += 250;
    response.status(201).end();
  });
  app.get('/failure', (_request, response) => {
    now += 2_000;
    response.status(503).end();
  });
  app.use('/internal', createMetricsRouter(metrics, (request) => request.get('x-monitor-token') === 'probe-secret'));
  app.use((_request, response) => response.sendStatus(404));
  const server = await listen(app);
  try {
    const request = await fetch(`${server.url}/api/v1/private/person@example.test?token=query-secret`, {
      headers: { 'x-monitor-token': 'header-secret', 'x-forwarded-for': '192.0.2.55' },
    });
    assert.equal(request.status, 201);
    const failed = await fetch(`${server.url}/failure?token=another-secret`);
    assert.equal(failed.status, 503);

    const denied = await fetch(`${server.url}/internal/metrics`);
    assert.equal(denied.status, 404);
    assert.doesNotMatch(await denied.text(), /api_http/);

    const scraped = await fetch(`${server.url}/internal/metrics`, { headers: { 'x-monitor-token': 'probe-secret' } });
    assert.equal(scraped.status, 200);
    assert.match(scraped.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(scraped.headers.get('cache-control'), 'no-store');
    const body = await scraped.text();
    assert.match(body, /api_http_requests_total\{method="GET",status_class="2xx"\} 1/);
    assert.match(body, /api_http_requests_total\{method="GET",status_class="5xx"\} 1/);
    assert.match(body, /api_http_request_duration_seconds_bucket\{method="GET",status_class="2xx",le="0\.25"\} 1/);
    assert.match(body, /api_http_requests_in_flight\{method="GET"\} 1/);
    for (const secret of ['person@example.test', 'query-secret', 'another-secret', 'probe-secret', 'header-secret', '192.0.2.55', '/api/v1/private']) {
      assert.equal(body.includes(secret), false, `metrics output contained ${secret}`);
    }
  } finally { await server.close(); }
});

test('metrics access fails closed when policy denies or throws, and endpoint construction requires policy', async () => {
  const metrics = new ApiMetrics();
  assert.throws(() => createMetricsRouter(metrics, undefined as never), /requires an authorization policy/);
  const app = express();
  app.use('/denied', createMetricsRouter(metrics, () => false));
  app.use('/error', createMetricsRouter(metrics, async () => { throw new Error('private authorization detail'); }));
  app.use((_request, response) => response.sendStatus(404));
  const server = await listen(app);
  try {
    for (const path of ['/denied/metrics', '/error/metrics']) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /private authorization detail|api_http/);
    }
  } finally { await server.close(); }
});

test('request observations are idempotent and classify unknown methods without storing them', () => {
  let now = 10;
  const metrics = new ApiMetrics(() => now);
  const observation = metrics.startRequest('CUSTOM-PRIVATE-METHOD');
  now += 20;
  observation.abort();
  observation.finish(200);
  const body = metrics.renderPrometheus();
  assert.match(body, /api_http_client_aborted_total\{method="OTHER"\} 1/);
  assert.match(body, /api_http_requests_in_flight\{method="OTHER"\} 0/);
  assert.doesNotMatch(body, /CUSTOM-PRIVATE-METHOD/);
});
