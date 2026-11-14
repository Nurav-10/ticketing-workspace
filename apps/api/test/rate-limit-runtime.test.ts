import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadRateLimitKey } from '../src/rate-limit/runtime.js';

test('rate-limit key requires a canonical independent 32-byte secret', () => {
  const secret = randomBytes(32);
  assert.deepEqual(loadRateLimitKey({ RATE_LIMIT_HMAC_KEY: secret.toString('base64url') }), secret);
  for (const invalid of [undefined, '', 'not-a-secret', randomBytes(31).toString('base64url'), `${secret.toString('base64url')}=`]) {
    const env: NodeJS.ProcessEnv = invalid === undefined ? {} : { RATE_LIMIT_HMAC_KEY: invalid };
    assert.throws(() => loadRateLimitKey(env), /Invalid rate-limit configuration/);
  }
});
