import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { composeAuthStack, AuthCompositionConfigurationError, type AuthCompositionInput, type AuthRateLimiters } from '../src/auth-flow/composition.js';

const config = {
  PUBLIC_ORIGIN: 'https://api.example.test',
  SESSION_COOKIE_NAME: '__Host-app_session',
};
const prisma = {} as unknown as PrismaClient;
const noOp: RequestHandler = (_request, _response, next) => next();
const rateLimiters: AuthRateLimiters = { login: noOp, callback: noOp, logout: noOp };
const oidcEnv = {
  OIDC_ISSUER: 'https://issuer.example.test/',
  OIDC_CLIENT_ID: 'api-client',
  OIDC_CLIENT_SECRET: 'do-not-print-this',
  OIDC_CALLBACK_URI: 'https://api.example.test/api/v1/auth/callback',
};

function input(overrides: Partial<AuthCompositionInput> = {}): AuthCompositionInput {
  return {
    config,
    prisma,
    env: {},
    ...overrides,
  };
}

test('absent OIDC configuration returns an unconfigured authenticator and no auth routes', async () => {
  const composition = await composeAuthStack(input());
  assert.equal(composition.configured, false);
  if (composition.configured) assert.fail('unexpected configured auth stack');
  assert.equal(composition.reason, 'provider_absent');
  assert.equal(composition.authenticator.configured, false);
  assert.equal(composition.router, null);
  assert.equal(composition.mountPath, null);
});

test('partial OIDC configuration fails with a generic configuration error', async () => {
  await assert.rejects(
    composeAuthStack(input({ env: { OIDC_ISSUER: oidcEnv.OIDC_ISSUER } })),
    AuthCompositionConfigurationError,
  );
});

test('valid OIDC configuration without its separate transaction key cannot enable auth', async () => {
  await assert.rejects(
    composeAuthStack(input({ env: oidcEnv, rateLimiters, sessionPolicy: { idleTimeoutMs: 60_000, absoluteTimeoutMs: 600_000, touchIntervalMs: 10_000 } })),
    AuthCompositionConfigurationError,
  );
});

test('every configured auth route requires its own injected rate-limit middleware', async () => {
  const env = { ...oidcEnv, OIDC_TRANSACTION_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
  const sessionPolicy = { idleTimeoutMs: 60_000, absoluteTimeoutMs: 600_000, touchIntervalMs: 10_000 };
  for (const missing of ['login', 'callback', 'logout'] as const) {
    const limiters = { ...rateLimiters, [missing]: undefined } as unknown as AuthRateLimiters;
    const composition = await composeAuthStack(input({ env, rateLimiters: limiters, sessionPolicy }));
    assert.equal(composition.configured, false);
    if (composition.configured) assert.fail(`${missing} limiter unexpectedly enabled auth`);
    assert.equal(composition.reason, 'rate_limiters_missing');
    assert.equal(composition.router, null);
    assert.equal(composition.authenticator.configured, false);
  }
});

test('configured bootstrap requires its own limiter before routes can be enabled', async () => {
  const env = { ...oidcEnv, OIDC_TRANSACTION_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
  const composition = await composeAuthStack(input({
    env,
    rateLimiters,
    sessionPolicy: { idleTimeoutMs: 60_000, absoluteTimeoutMs: 600_000, touchIntervalMs: 10_000 },
    bootstrap: { expectedGrantHash: randomBytes(32), workspace: { name: 'Primary', slug: 'primary' } },
  }));
  assert.equal(composition.configured, false);
  if (composition.configured) assert.fail('bootstrap unexpectedly enabled without its limiter');
  assert.equal(composition.reason, 'rate_limiters_missing');
});

test('bad HTTPS public origin, callback URI, callback origin mismatch, and non-host cookie fail closed', async () => {
  const env = { ...oidcEnv, OIDC_TRANSACTION_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
  const sessionPolicy = { idleTimeoutMs: 60_000, absoluteTimeoutMs: 600_000, touchIntervalMs: 10_000 };
  const invalidInputs = [
    input({ config: { ...config, PUBLIC_ORIGIN: 'http://api.example.test' }, env, rateLimiters, sessionPolicy }),
    input({ config: { ...config, SESSION_COOKIE_NAME: 'app_session' }, env, rateLimiters, sessionPolicy }),
    input({ config: { ...config, SESSION_COOKIE_NAME: '__Host-oidc_login_tx' }, env, rateLimiters, sessionPolicy }),
    input({ env: { ...env, OIDC_CALLBACK_URI: 'http://api.example.test/api/v1/auth/callback' }, rateLimiters, sessionPolicy }),
    input({ env: { ...env, OIDC_CALLBACK_URI: 'https://other.example.test/api/v1/auth/callback' }, rateLimiters, sessionPolicy }),
    input({ env: { ...env, OIDC_CALLBACK_URI: 'https://api.example.test/callback' }, rateLimiters, sessionPolicy }),
    input({ env: { ...env, OIDC_CALLBACK_URI: 'https://api.example.test/api/v1/auth/callback?next=https://evil.example' }, rateLimiters, sessionPolicy }),
  ];
  for (const candidate of invalidInputs) {
    await assert.rejects(composeAuthStack(candidate), AuthCompositionConfigurationError);
  }
});

test('transaction key must be canonical, exactly 32 bytes, and distinct from bootstrap grant hash', async () => {
  const sessionPolicy = { idleTimeoutMs: 60_000, absoluteTimeoutMs: 600_000, touchIntervalMs: 10_000 };
  await assert.rejects(composeAuthStack(input({
    env: { ...oidcEnv, OIDC_TRANSACTION_ENCRYPTION_KEY: 'not-a-key' }, rateLimiters, sessionPolicy,
  })), AuthCompositionConfigurationError);

  const sameKey = randomBytes(32);
  await assert.rejects(composeAuthStack(input({
    env: { ...oidcEnv, OIDC_TRANSACTION_ENCRYPTION_KEY: sameKey.toString('base64url') }, rateLimiters, sessionPolicy,
    bootstrap: { expectedGrantHash: sameKey, workspace: { name: 'Primary', slug: 'primary' } },
  })), AuthCompositionConfigurationError);
});

test('malformed optional bootstrap configuration fails even when OIDC is absent', async () => {
  await assert.rejects(composeAuthStack(input({
    bootstrap: { expectedGrantHash: randomBytes(31), workspace: { name: 'Primary', slug: 'primary' } },
  })), AuthCompositionConfigurationError);
});
