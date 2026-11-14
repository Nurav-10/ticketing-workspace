import type {
  IdentityRepository,
  IdentityResolution,
  InvitationProvisioningGrant,
  ValidatedProviderIdentity,
} from './identity-repository.js';

function isCanonicalHttpsIssuer(issuer: string): boolean {
  try {
    const parsed = new URL(issuer);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && parsed.href === issuer;
  } catch {
    return false;
  }
}

function validate(identity: ValidatedProviderIdentity): void {
  if (!isCanonicalHttpsIssuer(identity.issuer)
    || typeof identity.subject !== 'string'
    || identity.subject.length === 0
    || (identity.email !== null && typeof identity.email !== 'string')
    || typeof identity.emailVerified !== 'boolean'
    || (identity.displayName !== null && typeof identity.displayName !== 'string')) {
    throw new Error('Invalid validated provider identity');
  }
}

/** Application policy around the persistence port; it never trusts HTTP identity claims. */
export class IdentityService {
  constructor(private readonly repository: IdentityRepository) {}

  async resolve(identity: ValidatedProviderIdentity): Promise<IdentityResolution> {
    validate(identity);
    return this.repository.resolve(identity);
  }

  async provisionFromInvitation(
    identity: ValidatedProviderIdentity,
    grant: InvitationProvisioningGrant,
  ): Promise<IdentityResolution> {
    validate(identity);
    if (!grant || grant.kind !== 'invitation' || !Buffer.isBuffer(grant.tokenHash) || grant.tokenHash.byteLength !== 32) {
      return { kind: 'invitation_unavailable' };
    }
    if (!identity.email || identity.emailVerified !== true) return { kind: 'invitation_unavailable' };
    return this.repository.provisionFromInvitation(identity, grant);
  }
}
