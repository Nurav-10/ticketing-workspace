import type { Request } from 'express';

export interface Principal {
  /** Internal user ID linked to an identity provider subject at sign-in. */
  userId: string;
  /** Application-owned session ID, used for revocation-aware checks. */
  sessionId: string;
}

export interface Authenticator {
  /** False only for the deliberate local fail-closed adapter. */
  readonly configured: boolean;
  /**
   * Implementations must verify the opaque application session cookie, enforce its
   * expiry/revocation policy, and resolve its linked internal user ID. Provider identity
   * is validated at sign-in, not on every request. Never trust identity claims supplied
   * in request headers or body fields.
   */
  authenticate(request: Request, sessionCookieName: string): Promise<Principal | null>;
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      principal: Principal | null;
    }
  }
}

/** Fail-closed adapter for deployments that have not selected/configured an identity provider. */
export class UnconfiguredAuthenticator implements Authenticator {
  readonly configured = false;
  async authenticate(_request: Request, _sessionCookieName: string): Promise<Principal | null> { return null; }
}

export function assertProductionAuthenticator(nodeEnv: string, authenticator: Authenticator): void {
  if (nodeEnv === 'production' && !authenticator.configured) {
    throw new Error('Production startup requires a configured identity provider adapter');
  }
}
