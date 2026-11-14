import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import {
  createAuthRateLimiters,
  createInvitationRateLimiters,
  createRateLimitMiddleware,
} from '../src/rate-limit/middleware.js';

const noProxy = { trustProxy: false } as const;

function harness(request: Record<string, unknown>) {
  const response = {
    code: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  let nextCalls = 0;
  return {
    request: request as unknown as Request,
    response: response as unknown as Response & typeof response,
    next: () => { nextCalls++; },
    nextCalls: () => nextCalls,
  };
}

test('auth factory returns composition-ready middleware and keys requests by socket IP', async () => {
  const calls: [string, string][] = [];
  const middleware = createAuthRateLimiters({
    async consume(operation, identifier) {
      calls.push([operation, identifier]);
      return { allowed: true, limit: 10, remaining: 9, retryAfterMs: 0 };
    },
  }, noProxy);
  const h = harness({ socket: { remoteAddress: '203.0.113.7' }, get: () => '198.51.100.2' });
  await middleware.login(h.request, h.response, h.next);
  assert.deepEqual(calls, [['auth.login.ip', '203.0.113.7']]);
  assert.equal(h.nextCalls(), 1);
  assert.equal(typeof middleware.callback, 'function');
  assert.equal(typeof middleware.logout, 'function');
});

test('charges dimensions in order and stops on a denied bucket with a generic response', async () => {
  const calls: string[] = [];
  const middleware = createRateLimitMiddleware({
    async consume(operation) {
      calls.push(operation);
      return operation === 'second'
        ? { allowed: false, limit: 1, remaining: 0, retryAfterMs: 2_500, reason: 'limit' }
        : { allowed: true, limit: 2, remaining: 1, retryAfterMs: 0 };
    },
  }, { dimensions: [
    { operation: 'first', identifier: () => 'actor' },
    { operation: 'second', identifier: () => 'workspace' },
    { operation: 'third', identifier: () => 'never' },
  ] });
  const h = harness({});
  await middleware(h.request, h.response, h.next);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(h.nextCalls(), 0);
  assert.equal(h.response.code, 429);
  assert.equal(h.response.headers['Retry-After'], '3');
  assert.deepEqual(h.response.body, { error: { code: 'rate_limited', message: 'Too many requests' } });
});

test('fail closes when an identifier cannot be resolved or storage rejects', async () => {
  let calls = 0;
  const middleware = createRateLimitMiddleware({
    async consume() { calls++; throw new Error('db detail'); },
  }, { dimensions: [{ operation: 'bucket', identifier: () => null }] });
  const h = harness({});
  await middleware(h.request, h.response, h.next);
  assert.equal(calls, 0);
  assert.equal(h.nextCalls(), 0);
  assert.equal(h.response.code, 429);
  assert.equal(h.response.headers['Retry-After'], '1');

  const storageMiddleware = createRateLimitMiddleware({
    async consume() { calls++; throw new Error('db detail'); },
  }, { dimensions: [{ operation: 'bucket', identifier: () => 'valid' }] });
  const storage = harness({});
  await storageMiddleware(storage.request, storage.response, storage.next);
  assert.equal(calls, 1);
  assert.equal(storage.response.code, 429);
  assert.deepEqual(storage.response.body, { error: { code: 'rate_limited', message: 'Too many requests' } });
});

test('invitation middleware uses trusted actor and token dimensions', async () => {
  const calls: [string, string][] = [];
  const limiters = createInvitationRateLimiters({
    async consume(operation, identifier) {
      calls.push([operation, identifier]);
      return { allowed: true, limit: 10, remaining: 9, retryAfterMs: 0 };
    },
  }, noProxy);
  const issue = harness({ socket: { remoteAddress: '203.0.113.8' }, get: () => undefined, principal: { userId: 'user-1' } });
  await limiters.issue(issue.request, issue.response, issue.next);
  const redeem = harness({ socket: { remoteAddress: '203.0.113.9' }, get: () => undefined, body: { token: 'secret-token' } });
  await limiters.redeem(redeem.request, redeem.response, redeem.next);
  assert.deepEqual(calls, [
    ['invitation.issue.ip', '203.0.113.8'],
    ['invitation.issue.actor', 'user-1'],
    ['invitation.redeem.ip', '203.0.113.9'],
    ['invitation.redeem.token', 'secret-token'],
  ]);
});
