/**
 * Claims returned only by a completed OIDC verifier. This module has no HTTP/request
 * dependency; callers must never construct these values from request headers or body.
 */
export interface ValidatedProviderIdentity {
  /** Exact canonical issuer string from trusted provider configuration and validation. */
  issuer: string;
  /** Exact subject from the validated identity token; preserve case and bytes. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

/**
 * Server-derived SHA-256 digest of the 256-bit invitation secret. Keep it in the
 * server-side login transaction; never accept a hash from request headers or body.
 */
export interface InvitationProvisioningGrant {
  kind: 'invitation';
  /** Server-derived SHA-256 digest of a canonical 256-bit opaque invitation token. */
  tokenHash: Buffer;
}

export type IdentityResolution =
  | { kind: 'resolved'; userId: string }
  | { kind: 'account_disabled' }
  | { kind: 'provisioning_required' }
  | { kind: 'invitation_unavailable' }
  | { kind: 'retryable_conflict' };

export interface IdentityRepository {
  /** Resolve an exact issuer/subject key; this method never creates or links by email. */
  resolve(identity: ValidatedProviderIdentity): Promise<IdentityResolution>;
  /**
   * Provision a new user only through an existing verified, unexpired, unused invitation.
   * User, identity, membership and invitation consumption commit or roll back together.
   */
  provisionFromInvitation(
    identity: ValidatedProviderIdentity,
    grant: InvitationProvisioningGrant,
  ): Promise<IdentityResolution>;
}
