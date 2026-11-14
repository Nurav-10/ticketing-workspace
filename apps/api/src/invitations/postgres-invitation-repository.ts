import type pg from 'pg';
import { ApiError } from '../shared/api-error.js';
import type { InvitationRepository, RedeemInvitationResult } from './invitation-repository.js';

function normalizeEmail(value: string): string {
  // Phase 1 policy: trim surrounding whitespace and compare case-insensitively.
  // Do not apply provider-specific equivalence such as Gmail dot/plus rules.
  return value.trim().toLowerCase();
}

export class PostgresInvitationRepository implements InvitationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async redeem({ userId, tokenHash }: { userId: string; tokenHash: Buffer }): Promise<RedeemInvitationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT i.id, i.workspace_id, i.role, i.email, i.redeemed_at, i.revoked_at,
                (i.expires_at > now()) AS is_unexpired, u.email AS user_email, u.email_verified_at
         FROM invitations i JOIN users u ON u.id = $2
         WHERE i.token_hash = $1 FOR UPDATE OF i, u`, [tokenHash, userId]
      );
      const invitation = rows[0];
      if (!invitation || invitation.redeemed_at || invitation.revoked_at || !invitation.is_unexpired) {
        throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      }
      if (!invitation.email_verified_at || normalizeEmail(invitation.email) !== normalizeEmail(invitation.user_email)) {
        throw new ApiError(403, 'invitation_email_mismatch', 'A verified invited email is required');
      }
      const membership = await client.query(
        `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING workspace_id`,
        [invitation.workspace_id, userId, invitation.role]
      );
      if (membership.rowCount === 0) throw new ApiError(409, 'already_a_member', 'User is already a workspace member');
      await client.query('UPDATE invitations SET redeemed_at = now() WHERE id = $1', [invitation.id]);
      await client.query('COMMIT');
      return { workspaceId: invitation.workspace_id, role: invitation.role };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
