import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '../auth/authenticator.js';
import { ApiError } from '../shared/api-error.js';
import type { InvitationRepository, RedeemInvitationResult } from './invitation-repository.js';

export interface InvitationRedeemer {
  redeem(principal: Principal, token: string): Promise<RedeemInvitationResult>;
}

export class InvitationService implements InvitationRedeemer {
  constructor(private readonly repository: InvitationRepository) {}

  async redeem(principal: Principal, token: string): Promise<RedeemInvitationResult> {
    if (token.length < 40 || token.length > 100) throw new ApiError(400, 'invalid_request', 'Request validation failed');
    const tokenHash = createHash('sha256').update(token).digest();
    return this.repository.redeem({ userId: principal.userId, tokenHash });
  }
}

/** For future authorized issuer flows; only the hash belongs in PostgreSQL. */
export function createInvitationSecret(): { token: string; tokenHash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest() };
}
