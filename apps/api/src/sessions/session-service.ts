import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '../auth/authenticator.js';
import type { SessionRepository } from './session-repository.js';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SessionPolicy {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  touchIntervalMs: number;
}

export interface IssuedSession {
  /** Return to the caller once so it can be set as an HttpOnly cookie. Never log it. */
  token: string;
  sessionId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

function isPositiveDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** SHA-256 is appropriate here because the input is a uniformly random 256-bit secret. */
function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'ascii').digest();
}

function isCanonicalSessionToken(token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const decoded = Buffer.from(token, 'base64url');
  return decoded.length === TOKEN_BYTES && decoded.toString('base64url') === token;
}

export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly policy: SessionPolicy,
  ) {
    if (!isPositiveDuration(policy.idleTimeoutMs)
      || !isPositiveDuration(policy.absoluteTimeoutMs)
      || !isPositiveDuration(policy.touchIntervalMs)
      || policy.idleTimeoutMs > policy.absoluteTimeoutMs
      || policy.touchIntervalMs >= policy.idleTimeoutMs) {
      throw new Error('Invalid application session policy');
    }
  }

  async issue(userId: string): Promise<IssuedSession> {
    if (userId.length === 0) throw new Error('Cannot issue a session without a user ID');
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const created = await this.repository.create({
      userId,
      tokenHash: hashToken(token),
      idleTimeoutMs: this.policy.idleTimeoutMs,
      absoluteTimeoutMs: this.policy.absoluteTimeoutMs,
    });
    return {
      token,
      sessionId: created.id,
      idleExpiresAt: created.idleExpiresAt,
      absoluteExpiresAt: created.absoluteExpiresAt,
    };
  }

  async authenticate(token: string | null | undefined): Promise<Principal | null> {
    if (typeof token !== 'string' || !isCanonicalSessionToken(token)) return null;
    const session = await this.repository.authenticate({
      tokenHash: hashToken(token),
      idleTimeoutMs: this.policy.idleTimeoutMs,
      touchIntervalMs: this.policy.touchIntervalMs,
    });
    return session ? { userId: session.userId, sessionId: session.sessionId } : null;
  }

  /** Idempotently revoke a presented token. Malformed tokens are treated as absent. */
  async revoke(token: string | null | undefined): Promise<void> {
    if (typeof token !== 'string' || !isCanonicalSessionToken(token)) return;
    await this.repository.revoke(hashToken(token));
  }
}
