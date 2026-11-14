/** Opaque application session metadata returned after persistence. */
export interface CreatedSession {
  id: string;
  userId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface CreateSessionRecord {
  userId: string;
  /** SHA-256 digest of the bearer token. The bearer token itself must never be persisted. */
  tokenHash: Buffer;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

export interface AuthenticateSessionRecord {
  tokenHash: Buffer;
  idleTimeoutMs: number;
  /** Bound last_seen_at writes to avoid one database write per request. */
  touchIntervalMs: number;
}

/**
 * Persistence boundary for application sessions.
 *
 * Implementations must create timestamps from one database time snapshot. Authentication
 * must atomically reject revoked, idle-expired, absolute-expired sessions and inactive
 * users, while refreshing idle expiry (capped at absolute expiry) no more often than the
 * supplied touch interval. Revocation must atomically set revoked_at using database time
 * and be idempotent. A request that races a revocation may finish, but every later lookup
 * must observe the committed revocation. Membership and resource authorization remain
 * request-time checks in their own repositories/services; session validity is not a
 * substitute for those checks. Membership removal or account-status changes that should
 * sign a user out must also invoke a reviewed local revocation operation; this port does
 * not decide those product policies or perform those cross-record operations. Use the
 * database clock for creation, expiration checks, idle refresh, and revocation; do not
 * compare against separate application-host timestamps. Keep authentication uncached so a
 * committed revocation is visible to the next lookup.
 */
export interface SessionRepository {
  create(record: CreateSessionRecord): Promise<CreatedSession>;
  authenticate(record: AuthenticateSessionRecord): Promise<{ userId: string; sessionId: string } | null>;
  revoke(tokenHash: Buffer): Promise<void>;
}
