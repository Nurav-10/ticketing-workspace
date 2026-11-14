import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { loadMetricsAuthorizer } from '../src/observability/config.js';

test('metrics exposure is opt-in and requires an independent canonical bearer secret', async () => {
  assert.equal(loadMetricsAuthorizer({}), undefined);
  const token = randomBytes(32).toString('base64url');
  assert.throws(() => loadMetricsAuthorizer({ METRICS_BEARER_TOKEN: 'short' }));
  assert.throws(() => loadMetricsAuthorizer({ METRICS_BEARER_TOKEN: token, RATE_LIMIT_HMAC_KEY: token }));
  const authorize = loadMetricsAuthorizer({ METRICS_BEARER_TOKEN: token })!;
  const request = (header: string | undefined) => ({ get: () => header }) as unknown as Request;
  assert.equal(await authorize(request(`Bearer ${token}`)), true);
  assert.equal(await authorize(request(`Bearer ${randomBytes(32).toString('base64url')}`)), false);
  assert.equal(await authorize(request(undefined)), false);
});
