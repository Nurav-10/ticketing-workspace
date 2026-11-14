import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '../auth/authenticator.js';
import { ApiError } from '../shared/api-error.js';
import type { InvitationRepository, InvitationRole, IssuedInvitationRecord, RedeemInvitationResult } from './invitation-repository.js';

export interface InvitationRedeemer {
  redeem(principal: Principal, token: string): Promise<RedeemInvitationResult>;
}

export interface InvitationAdministrator extends InvitationRedeemer {
  issue(principal: Principal, workspaceId: string, input: { email: string; role: InvitationRole }): Promise<IssuedInvitationRecord & { token: string }>;
  revoke(principal: Principal, workspaceId: string, invitationId: string): Promise<void>;
}

export class InvitationService implements InvitationAdministrator {
  constructor(private readonly repository: InvitationRepository) {}

  async redeem(principal: Principal, token: string): Promise<RedeemInvitationResult> {
    if (token.length < 40 || token.length > 100) throw new ApiError(400, 'invalid_request', 'Request validation failed');
    const tokenHash = createHash('sha256').update(token).digest();
    return this.repository.redeem({ userId: principal.userId, tokenHash });
  }

  async issue(principal: Principal, workspaceId: string, input: { email: string; role: InvitationRole }): Promise<IssuedInvitationRecord & { token: string }> {
    const email = normalizeInvitationEmail(input.email);
    if (!isValidEmail(email) || !['admin', 'member'].includes(input.role)) {
      throw new ApiError(400, 'invalid_request', 'Request validation failed');
    }
    const secret = createInvitationSecret();
    const invitation = await this.repository.issue({
      workspaceId,
      actorUserId: principal.userId,
      email,
      role: input.role,
      tokenHash: secret.tokenHash
    });
    return { ...invitation, token: secret.token };
  }

  revoke(principal: Principal, workspaceId: string, invitationId: string): Promise<void> {
    return this.repository.revoke({ workspaceId, actorUserId: principal.userId, invitationId });
  }
}

export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Generates a one-time manual-share token; callers persist only tokenHash. */
export function createInvitationSecret(): { token: string; tokenHash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest() };
}
