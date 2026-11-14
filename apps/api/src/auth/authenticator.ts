import type { FastifyRequest } from 'fastify';

export interface Principal {
  /** Internal user ID resolved only after verifying the provider session. */
  userId: string;
  /** Provider-issued session identifier, used for revocation-aware adapters. */
  sessionId: string;
}

export interface Authenticator {
  /** False only for the deliberate local fail-closed adapter. */
  readonly configured: boolean;
  /**
   * Implementations must verify the opaque session cookie with the selected provider,
   * honor expiry/revocation, and resolve the provider subject to an internal user ID.
   * They must not trust user IDs or verified-email claims supplied in request headers.
   */
  authenticate(request: FastifyRequest, sessionCookieName: string): Promise<Principal | null>;
}

declare module 'fastify' {
  interface FastifyRequest { principal: Principal | null; }
}

/** Fail-closed adapter for deployments that have not selected/configured an identity provider. */
export class UnconfiguredAuthenticator implements Authenticator {
  readonly configured = false;
  async authenticate(): Promise<Principal | null> { return null; }
}

export function assertProductionAuthenticator(nodeEnv: string, authenticator: Authenticator): void {
  if (nodeEnv === 'production' && !authenticator.configured) {
    throw new Error('Production startup requires a configured identity provider adapter');
  }
}
