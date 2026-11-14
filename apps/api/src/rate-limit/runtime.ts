import type { PrismaClient } from '../generated/prisma/client.js';
import { PrismaRateLimitRepository } from './prisma-rate-limit-repository.js';
import { RateLimiter, type RateLimitPolicy } from './rate-limiter.js';
import { createAuthRateLimiters, createInvitationRateLimiters, type AuthLimiterHandlers, type InvitationLimiterHandlers } from './middleware.js';

const minute = 60_000;
const hour = 60 * minute;
const policy = (limit: number, windowMs: number): RateLimitPolicy => ({ limit, windowMs, retentionMs: hour });
const policies: Readonly<Record<string, RateLimitPolicy>> = {
  'auth.login.ip': policy(30, minute),
  'auth.callback.ip': policy(60, minute),
  'auth.logout.ip': policy(60, minute),
  'auth.bootstrap.ip': policy(5, minute),
  'invitation.issue.ip': policy(30, minute),
  'invitation.issue.actor': policy(100, hour),
  'invitation.redeem.ip': policy(30, minute),
  'invitation.redeem.token': policy(10, minute),
};

/** A dedicated key is mandatory; malformed configuration is never silently accepted. */
export function loadRateLimitKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.RATE_LIMIT_HMAC_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('Invalid rate-limit configuration');
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) throw new Error('Invalid rate-limit configuration');
  return key;
}

export function createRuntimeRateLimiters(prisma: PrismaClient, env: NodeJS.ProcessEnv): { auth: AuthLimiterHandlers; invitations: InvitationLimiterHandlers } {
  const key = loadRateLimitKey(env);
  if ([env.OIDC_TRANSACTION_ENCRYPTION_KEY, env.OIDC_CLIENT_SECRET, env.BOOTSTRAP_GRANT_HASH].includes(key.toString('base64url'))) {
    throw new Error('Rate-limit key must be independent');
  }
  const limiter = new RateLimiter(new PrismaRateLimitRepository(prisma), { hmacSecret: key, policies });
  const addressPolicy = { trustProxy: false } as const;
  return {
    auth: createAuthRateLimiters(limiter, addressPolicy),
    invitations: createInvitationRateLimiters(limiter, addressPolicy),
  };
}
