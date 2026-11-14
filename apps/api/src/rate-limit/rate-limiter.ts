import { createHmac } from 'node:crypto';
import type { RateLimitBucketObservation, RateLimitRepository } from './rate-limit-repository.js';

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
  /** How long a completed window is retained before cleanup may delete its row. */
  retentionMs: number;
}

export interface RateLimiterOptions {
  /** Dedicated random 32-byte secret; do not reuse another application key. */
  hmacSecret: Buffer;
  policies: Readonly<Record<string, RateLimitPolicy>>;
}

export type RateLimitDecision =
  | { allowed: true; limit: number; remaining: number; retryAfterMs: 0 }
  | { allowed: false; limit: number; remaining: 0; retryAfterMs: number; reason: 'limit' | 'storage' | 'invalid' };

const operationPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const minimumWindowMs = 1_000;
const maximumWindowMs = 24 * 60 * 60 * 1_000;
const maximumRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const maximumLimit = 1_000_000;
const maximumCleanupBatchSize = 5_000;

function validatePolicy(operation: string, policy: RateLimitPolicy): void {
  if (!operationPattern.test(operation)) throw new Error('Invalid rate-limit operation name');
  if (!policy || !Number.isSafeInteger(policy.limit) || policy.limit < 1 || policy.limit > maximumLimit) {
    throw new Error(`Invalid rate-limit limit for ${operation}`);
  }
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs < minimumWindowMs || policy.windowMs > maximumWindowMs) {
    throw new Error(`Invalid rate-limit window for ${operation}`);
  }
  if (!Number.isSafeInteger(policy.retentionMs) || policy.retentionMs < policy.windowMs || policy.retentionMs > maximumRetentionMs) {
    throw new Error(`Invalid rate-limit retention for ${operation}`);
  }
}

function validateOptions(options: RateLimiterOptions): void {
  if (!options || !Buffer.isBuffer(options.hmacSecret) || options.hmacSecret.byteLength !== 32) {
    throw new Error('Rate-limit HMAC secret must be explicitly configured as 32 independent random bytes');
  }
  if (!options.policies || typeof options.policies !== 'object' || Array.isArray(options.policies)) {
    throw new Error('Rate-limit policies must be explicitly configured');
  }
  const operations = Object.keys(options.policies);
  if (operations.length === 0) throw new Error('At least one rate-limit operation must be configured');
  for (const operation of operations) validatePolicy(operation, options.policies[operation]!);
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  return Buffer.byteLength(value, 'utf8') <= 512;
}

/** Shared fixed-window rate limiter backed by a multi-instance repository. */
export class RateLimiter {
  private readonly hmacSecret: Buffer;
  private readonly policies: ReadonlyMap<string, RateLimitPolicy>;

  constructor(private readonly repository: RateLimitRepository, options: RateLimiterOptions) {
    validateOptions(options);
    this.hmacSecret = Buffer.from(options.hmacSecret);
    this.policies = new Map(Object.entries(options.policies).map(([operation, policy]) => [operation, { ...policy }]));
  }

  async consume(operation: string, identifier: string): Promise<RateLimitDecision> {
    const policy = this.policies.get(operation);
    if (!policy || !isIdentifier(identifier)) {
      return { allowed: false, limit: policy?.limit ?? 0, remaining: 0, retryAfterMs: policy?.windowMs ?? minimumWindowMs, reason: 'invalid' };
    }

    const identifierHash = createHmac('sha256', this.hmacSecret)
      .update(operation, 'utf8')
      .update('\0', 'utf8')
      .update(identifier, 'utf8')
      .digest();

    let observation: RateLimitBucketObservation;
    try {
      observation = await this.repository.increment({
        operation,
        identifierHash,
        windowMs: policy.windowMs,
        retentionMs: policy.retentionMs,
      });
    } catch {
      return { allowed: false, limit: policy.limit, remaining: 0, retryAfterMs: policy.windowMs, reason: 'storage' };
    }

    if (!observation || typeof observation !== 'object') {
      return { allowed: false, limit: policy.limit, remaining: 0, retryAfterMs: policy.windowMs, reason: 'storage' };
    }
    const windowStart = observation.windowStartsAt instanceof Date ? observation.windowStartsAt.getTime() : Number.NaN;
    const windowEnd = observation.windowEndsAt instanceof Date ? observation.windowEndsAt.getTime() : Number.NaN;
    const databaseNow = observation.databaseNow instanceof Date ? observation.databaseNow.getTime() : Number.NaN;
    if (typeof observation.hitCount !== 'bigint' || observation.hitCount < 1n
      || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || !Number.isFinite(databaseNow)
      || windowStart! > databaseNow! || databaseNow! >= windowEnd! || windowEnd! <= windowStart!) {
      return { allowed: false, limit: policy.limit, remaining: 0, retryAfterMs: policy.windowMs, reason: 'storage' };
    }

    const retryAfterMs = Math.max(0, Math.ceil(windowEnd! - databaseNow!));
    if (observation.hitCount <= BigInt(policy.limit)) {
      return {
        allowed: true,
        limit: policy.limit,
        remaining: policy.limit - Number(observation.hitCount),
        retryAfterMs: 0,
      };
    }
    return { allowed: false, limit: policy.limit, remaining: 0, retryAfterMs, reason: 'limit' };
  }

  /** Maintenance hook for a scheduled cleanup job; not called on the request path. */
  deleteExpired(batchSize = 500): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximumCleanupBatchSize) {
      throw new Error(`Rate-limit cleanup batch size must be between 1 and ${maximumCleanupBatchSize}`);
    }
    return this.repository.deleteExpired(batchSize);
  }
}
