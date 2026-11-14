import { createHash, timingSafeEqual } from 'node:crypto';
import type { ValidatedProviderIdentity } from '../identity-persistence/identity-repository.js';
import type { BootstrapRepository, BootstrapResult, BootstrapWorkspace } from './bootstrap-repository.js';

export interface BootstrapServiceOptions {
  /** SHA-256 digest of the decoded 32-byte operator secret; required explicitly. */
  expectedGrantHash: Buffer;
  /** Trusted deployment configuration; never accepted from a public request. */
  workspace: BootstrapWorkspace;
}

export interface BootstrapAttempt {
  identity: ValidatedProviderIdentity;
  /** Server-derived SHA-256 digest kept only inside the encrypted OIDC transaction. */
  grantHash: Buffer;
}

/**
 * Convert an operator secret into the only value carried across OIDC redirects.
 * The input must be canonical base64url for exactly 32 random bytes.
 */
export function deriveBootstrapGrantHash(secret: unknown): Buffer | null {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== secret) return null;
  return createHash('sha256').update(decoded).digest();
}

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

function isValidIdentity(identity: unknown): identity is ValidatedProviderIdentity {
  if (!identity || typeof identity !== 'object') return false;
  const candidate = identity as Partial<ValidatedProviderIdentity>;
  return typeof candidate.issuer === 'string'
    && isCanonicalHttpsIssuer(candidate.issuer)
    && typeof candidate.subject === 'string'
    && candidate.subject.length > 0
    && typeof candidate.email === 'string'
    && candidate.email.trim().length > 0
    && candidate.emailVerified === true
    && (candidate.displayName === null || typeof candidate.displayName === 'string');
}

function validateOptions(options: BootstrapServiceOptions): void {
  if (!options || !Buffer.isBuffer(options.expectedGrantHash) || options.expectedGrantHash.byteLength !== 32) {
    throw new Error('Bootstrap grant hash must be explicitly configured as 32 bytes');
  }
  const name = options.workspace?.name;
  const slug = options.workspace?.slug;
  if (typeof name !== 'string' || !name.trim() || name.length > 120
    || typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 48) {
    throw new Error('Bootstrap workspace configuration is invalid');
  }
}

/**
 * Internal-only bootstrap coordinator. Do not expose this service as a public
 * unauthenticated endpoint; the caller must be trusted server-side OIDC flow.
 */
export class BootstrapService {
  private readonly expectedGrantHash: Buffer;
  private readonly workspace: BootstrapWorkspace;

  constructor(private readonly repository: BootstrapRepository, options: BootstrapServiceOptions) {
    validateOptions(options);
    this.expectedGrantHash = Buffer.from(options.expectedGrantHash);
    this.workspace = { ...options.workspace };
  }

  acceptsGrant(grantHash: Buffer): boolean {
    return Buffer.isBuffer(grantHash) && grantHash.byteLength === 32
      && timingSafeEqual(grantHash, this.expectedGrantHash);
  }

  async bootstrap(attempt: BootstrapAttempt): Promise<BootstrapResult> {
    if (!attempt || !isValidIdentity(attempt.identity)
      || !Buffer.isBuffer(attempt.grantHash) || attempt.grantHash.byteLength !== 32) {
      return { kind: 'unavailable' };
    }

    // Both inputs have a fixed size before comparison, so timingSafeEqual cannot
    // throw on length mismatch or disclose a prefix match.
    if (!this.acceptsGrant(attempt.grantHash)) {
      return { kind: 'unavailable' };
    }

    return this.repository.createFirstWorkspace({ identity: attempt.identity, workspace: this.workspace });
  }
}
