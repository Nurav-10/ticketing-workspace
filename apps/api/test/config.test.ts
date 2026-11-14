import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';

test('validates required database configuration and parses bounded port', () => {
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://localhost/db', PUBLIC_ORIGIN: 'http://localhost:3000', PORT: '4321' }).PORT, 4321);
  assert.throws(() => loadConfig({ DATABASE_URL: '', PUBLIC_ORIGIN: 'https://example.com', PORT: '70000' }), /Invalid environment/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/db', PUBLIC_ORIGIN: 'https://example.com/path' }), /Invalid environment/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/db', PUBLIC_ORIGIN: 'ftp://example.com' }), /Invalid environment/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/db', PUBLIC_ORIGIN: 'http://example.com' }), /HTTPS in production/);
});
