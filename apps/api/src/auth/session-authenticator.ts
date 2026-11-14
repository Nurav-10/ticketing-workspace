import type { Request } from 'express';
import type { Authenticator, Principal } from './authenticator.js';
import type { SessionService } from '../sessions/session-service.js';

export interface SessionAuthenticatorReadiness {
  /**
   * Set true only after provider callback validation and trusted identity resolution are
   * implemented and enabled. A session repository or database connection alone is not
   * enough to make this authenticator configured.
   */
  providerAuthenticationComplete: boolean;
}

/** Reads the app-owned cookie and delegates all token validity checks to SessionService. */
export class SessionAuthenticator implements Authenticator {
  readonly configured: boolean;

  constructor(
    private readonly sessions: Pick<SessionService, 'authenticate'>,
    readiness: SessionAuthenticatorReadiness,
  ) {
    this.configured = readiness.providerAuthenticationComplete;
  }

  async authenticate(request: Request, sessionCookieName: string): Promise<Principal | null> {
    if (!this.configured) return null;

    // cookie-parser populates request.cookies. Do not accept cookie header text, bearer
    // headers, request bodies, or client supplied identity fields as alternate sources.
    const candidate: unknown = request.cookies?.[sessionCookieName];
    return this.sessions.authenticate(typeof candidate === 'string' ? candidate : undefined);
  }
}
