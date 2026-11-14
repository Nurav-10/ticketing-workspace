import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadBootstrapConfiguration } from '../src/bootstrap/config.js';

test('bootstrap requires a complete canonical deployment configuration', () => {
  assert.equal(loadBootstrapConfiguration({}), undefined);
  assert.throws(() => loadBootstrapConfiguration({ BOOTSTRAP_WORKSPACE_NAME: 'Acme' }));
  const digest = randomBytes(32);
  assert.deepEqual(loadBootstrapConfiguration({
    BOOTSTRAP_GRANT_HASH: digest.toString('base64url'),
    BOOTSTRAP_WORKSPACE_NAME: 'Acme',
    BOOTSTRAP_WORKSPACE_SLUG: 'acme',
  }), { expectedGrantHash: digest, workspace: { name: 'Acme', slug: 'acme' } });
  assert.throws(() => loadBootstrapConfiguration({
    BOOTSTRAP_GRANT_HASH: `${digest.toString('base64url')}=`,
    BOOTSTRAP_WORKSPACE_NAME: 'Acme',
    BOOTSTRAP_WORKSPACE_SLUG: 'acme',
  }));
});
