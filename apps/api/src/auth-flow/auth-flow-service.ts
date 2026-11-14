import { createHash } from 'node:crypto';
import type { SessionService } from '../sessions/session-service.js';
import type {
  IdentityResolution,
  ValidatedProviderIdentity,
} from '../identity-persistence/identity-repository.js';
import type {
  CompletedOidcIdentity,
  LoginTransactionContext,
  VerifiedOidcIdentity,
} from '../identity/oidc-provider.js';
import type { RedeemInvitationResult } from '../invitations/invitation-repository.js';
import { deriveBootstrapGrantHash } from '../bootstrap/bootstrap-service.js';

const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type OidcLoginContext = LoginTransactionContext;
export type CompletedOidcLogin = CompletedOidcIdentity;

/** Expected extension of OidcIdentityProvider for encrypted transaction context. */
export interface AuthFlowOidcProvider {
  beginLogin(context?: OidcLoginContext): Promise<{ transactionHandle: string; authorizationUrl: string }>;
  completeLogin(callbackUrl: URL, transactionHandle: string | undefined): Promise<CompletedOidcLogin>;
}

export interface AuthFlowIdentityService {
  resolve(identity: ValidatedProviderIdentity): Promise<IdentityResolution>;
  provisionFromInvitation(
    identity: ValidatedProviderIdentity,
    grant: { kind: 'invitation'; tokenHash: Buffer },
  ): Promise<IdentityResolution>;
}

/** The repository rechecks persisted user status/email and consumes the invite atomically. */
export interface AuthFlowInvitationRedeemer {
  redeem(input: { userId: string; tokenHash: Buffer }): Promise<RedeemInvitationResult>;
}

export interface AuthFlowBootstrapper {
  acceptsGrant(grantHash: Buffer): boolean;
  bootstrap(input: { identity: ValidatedProviderIdentity; grantHash: Buffer }): Promise<
    { kind: 'created'; userId: string; workspaceId: string } | { kind: 'unavailable' }
  >;
}

export type AuthFlowSessionService = Pick<SessionService, 'issue' | 'revoke'>;

export type AuthFlowErrorCode = 'not_configured' | 'invalid_request' | 'rejected' | 'unavailable';

export class AuthFlowError extends Error {
  constructor(readonly code: AuthFlowErrorCode) {
    super('Sign-in could not be completed');
    this.name = 'AuthFlowError';
  }
}

export interface AuthFlowStartResult {
  transactionHandle: string;
  authorizationUrl: string;
}

export interface AuthFlowCompleteResult {
  session: Awaited<ReturnType<SessionService['issue']>>;
  redirectUrl: string;
}

function invitationSecretDigest(token: unknown): string | null {
  if (typeof token !== 'string' || !INVITATION_TOKEN_PATTERN.test(token)) return null;
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== token) return null;
  // Keep in sync with IdentityService: it hashes the canonical ASCII token string.
  return createHash('sha256').update(token, 'ascii').digest('base64url');
}

function decodeInvitationDigest(encoded: string | undefined): Buffer | null {
  if (!encoded || !HASH_PATTERN.test(encoded)) return null;
  const digest = Buffer.from(encoded, 'base64url');
  return digest.length === 32 && digest.toString('base64url') === encoded ? digest : null;
}

function toValidatedIdentity(identity: VerifiedOidcIdentity): ValidatedProviderIdentity {
  let issuer: URL;
  try { issuer = new URL(identity.issuer); } catch { throw new AuthFlowError('rejected'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || identity.subject.length === 0
    || identity.emailVerified !== true || identity.email.trim().length === 0) {
    throw new AuthFlowError('rejected');
  }
  return {
    issuer: identity.issuer,
    subject: identity.subject,
    email: identity.email,
    emailVerified: identity.emailVerified,
    displayName: identity.displayName ?? null,
  };
}

function isResolved(result: IdentityResolution): result is { kind: 'resolved'; userId: string } {
  return result.kind === 'resolved' && result.userId.length > 0;
}

/** Coordinates verified OIDC identity, explicit invitation grant, and app-owned session issue. */
export class AuthFlowService {
  constructor(
    private readonly provider: AuthFlowOidcProvider | null,
    private readonly identities: AuthFlowIdentityService,
    private readonly sessions: AuthFlowSessionService,
    private readonly publicOrigin: string,
    private readonly invitations: AuthFlowInvitationRedeemer,
    private readonly bootstrapper: AuthFlowBootstrapper | null = null,
  ) {
    const origin = new URL(publicOrigin);
    if (origin.origin !== publicOrigin || origin.protocol !== 'https:' || origin.username || origin.password) {
      throw new Error('Auth flow public origin must be a canonical HTTPS origin');
    }
  }

  async beginLogin(invitationToken?: unknown): Promise<AuthFlowStartResult> {
    if (!this.provider) throw new AuthFlowError('not_configured');
    const invitationTokenHash = invitationToken === undefined ? null : invitationSecretDigest(invitationToken);
    if (invitationToken !== undefined && invitationTokenHash === null) throw new AuthFlowError('invalid_request');

    try {
      const context = invitationTokenHash === null ? undefined : { invitationTokenHash };
      const started = await this.provider.beginLogin(context);
      const authorizationUrl = new URL(started.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:'
        || authorizationUrl.username !== ''
        || authorizationUrl.password !== ''
        || authorizationUrl.hash !== ''
        || (invitationTokenHash && started.authorizationUrl.includes(invitationTokenHash))
        || (typeof invitationToken === 'string' && started.authorizationUrl.includes(invitationToken))) {
        throw new AuthFlowError('unavailable');
      }
      return started;
    } catch (error) {
      if (error instanceof AuthFlowError) throw error;
      throw new AuthFlowError('unavailable');
    }
  }

  /** Internal-only bootstrap entry point. Never mount this directly on an unauthenticated route. */
  async beginBootstrapLogin(operatorSecret: unknown): Promise<AuthFlowStartResult> {
    if (!this.provider || !this.bootstrapper) {
      throw new AuthFlowError('not_configured');
    }
    const grantHash = deriveBootstrapGrantHash(operatorSecret);
    if (!grantHash) throw new AuthFlowError('invalid_request');
    if (!this.bootstrapper.acceptsGrant(grantHash)) throw new AuthFlowError('rejected');
    try {
      const bootstrapGrantHash = grantHash.toString('base64url');
      const started = await this.provider.beginLogin({ bootstrapGrantHash });
      const authorizationUrl = new URL(started.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.username || authorizationUrl.password
        || authorizationUrl.hash || started.authorizationUrl.includes(bootstrapGrantHash)
        || (typeof operatorSecret === 'string' && started.authorizationUrl.includes(operatorSecret))) {
        throw new AuthFlowError('unavailable');
      }
      return started;
    } catch (error) {
      if (error instanceof AuthFlowError) throw error;
      throw new AuthFlowError('unavailable');
    }
  }

  async completeLogin(callbackUrl: URL, transactionHandle: string | undefined): Promise<AuthFlowCompleteResult> {
    if (!this.provider) throw new AuthFlowError('not_configured');

    let completed: CompletedOidcLogin;
    try {
      completed = await this.provider.completeLogin(callbackUrl, transactionHandle);
    } catch {
      throw new AuthFlowError('rejected');
    }

    const identity = toValidatedIdentity(completed.identity);
    let resolution: IdentityResolution;
    try {
      resolution = await this.identities.resolve(identity);
      if (completed.invitationTokenHash !== undefined && completed.bootstrapGrantHash !== undefined) {
        throw new AuthFlowError('rejected');
      }
      if (resolution.kind === 'provisioning_required') {
        const tokenHash = decodeInvitationDigest(completed.invitationTokenHash);
        if (tokenHash) {
          resolution = await this.identities.provisionFromInvitation(identity, { kind: 'invitation', tokenHash });
          if (resolution.kind === 'retryable_conflict') {
            // Another request created this exact identity. Re-resolve and consume
            // this request's invitation rather than silently discarding its grant.
            resolution = await this.identities.resolve(identity);
            if (resolution.kind === 'resolved') {
              await this.invitations.redeem({ userId: resolution.userId, tokenHash });
            }
          }
        } else {
          const grantHash = decodeInvitationDigest(completed.bootstrapGrantHash);
          if (!grantHash || !this.bootstrapper) throw new AuthFlowError('rejected');
          const created = await this.bootstrapper.bootstrap({ identity, grantHash });
          resolution = created.kind === 'created' ? { kind: 'resolved', userId: created.userId } : { kind: 'invitation_unavailable' };
        }
      } else if (resolution.kind === 'resolved' && completed.invitationTokenHash !== undefined) {
        const tokenHash = decodeInvitationDigest(completed.invitationTokenHash);
        if (!tokenHash) throw new AuthFlowError('rejected');
        // The invitation repository verifies the persisted verified email, active user,
        // invitation state, and membership while consuming the grant transactionally.
        await this.invitations.redeem({ userId: resolution.userId, tokenHash });
      } else if (completed.bootstrapGrantHash !== undefined) {
        // Bootstrap is restricted to a new identity and a trusted internal caller.
        throw new AuthFlowError('rejected');
      }
    } catch (error) {
      if (error instanceof AuthFlowError) throw error;
      throw new AuthFlowError('unavailable');
    }

    // Existing exact issuer/subject identities resolve without an invitation grant.
    // A new identity never receives a session unless invitation provisioning succeeds.
    if (!isResolved(resolution)) throw new AuthFlowError('rejected');

    let session: AuthFlowCompleteResult['session'];
    try {
      session = await this.sessions.issue(resolution.userId);
    } catch {
      throw new AuthFlowError('unavailable');
    }
    return { session, redirectUrl: new URL('/', this.publicOrigin).href };
  }

  async revokeIssuedSession(token: string): Promise<void> {
    try {
      await this.sessions.revoke(token);
    } catch {
      throw new AuthFlowError('unavailable');
    }
  }
}
