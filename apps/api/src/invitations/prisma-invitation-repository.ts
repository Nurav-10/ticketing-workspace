import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { writeSecurityAuditEvent } from '../audit/security-audit-writer.js';
import { ApiError } from '../shared/api-error.js';
import type { InvitationRepository, IssuedInvitationRecord, RedeemInvitationResult } from './invitation-repository.js';

interface LockedInvitation {
  id: string;
  workspace_id: string;
  role: 'admin' | 'member';
  email: string;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  user_email: string;
  email_verified_at: Date | null;
  user_status: string;
}

interface InvitationWorkspace {
  id: string;
}

interface LockedIssuerMembership {
  role: string;
}

interface CandidateAccount {
  is_member: boolean;
}

interface ExistingInvitation {
  id: string;
  expires_at: Date;
}

interface LockedRevokeInvitation {
  id: string;
  role: 'admin' | 'member';
  redeemed_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async issue({ workspaceId, actorUserId, email, role, tokenHash }: {
    workspaceId: string;
    actorUserId: string;
    email: string;
    role: 'admin' | 'member';
    tokenHash: Buffer;
  }): Promise<IssuedInvitationRecord> {
    const prismaTokenHash = Uint8Array.from(tokenHash);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, workspaceId);
      const actor = await this.lockIssuerMembership(transaction, workspaceId, actorUserId);
      if (actor.role !== 'owner' && actor.role !== 'admin') {
        throw new ApiError(403, 'forbidden', 'You cannot issue invitations for this workspace');
      }
      if (role === 'admin' && actor.role !== 'owner') {
        throw new ApiError(403, 'forbidden', 'Only the workspace owner can invite administrators');
      }

      const accounts = await transaction.$queryRaw<CandidateAccount[]>`
        SELECT (wm.user_id IS NOT NULL) AS is_member
        FROM users AS u
        LEFT JOIN workspace_memberships AS wm
          ON wm.workspace_id = ${workspaceId}::uuid
         AND wm.user_id = u.id
        WHERE lower(btrim(u.email)) = ${email}
        ORDER BY u.id
        FOR UPDATE OF u`;
      if (accounts.some((account) => account.is_member)) {
        throw new ApiError(409, 'already_a_member', 'This email already belongs to a workspace member');
      }

      const existing = await transaction.$queryRaw<ExistingInvitation[]>`
        SELECT id::text AS id, expires_at
        FROM invitations
        WHERE workspace_id = ${workspaceId}::uuid
          AND lower(btrim(email)) = ${email}
          AND redeemed_at IS NULL
          AND revoked_at IS NULL
        ORDER BY id
        FOR UPDATE`;
      const nowRows = await transaction.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const checkedAt = nowRows[0]?.now;
      if (!checkedAt) throw new Error('Database clock query returned no timestamp.');
      if (existing.some((invitation) => invitation.expires_at > checkedAt)) {
        throw new ApiError(409, 'invitation_exists', 'A pending invitation already exists for this email');
      }
      const expiredIds = existing.filter((invitation) => invitation.expires_at <= checkedAt).map(({ id }) => id);
      if (expiredIds.length) {
        await transaction.invitation.updateMany({
          where: {
            id: { in: expiredIds },
            redeemedAt: null,
            revokedAt: null,
            expiresAt: { lte: checkedAt }
          },
          data: { revokedAt: checkedAt }
        });
      }

      const invitation = await transaction.invitation.create({
        data: {
          workspaceId,
          email,
          role,
          tokenHash: prismaTokenHash,
          invitedBy: actorUserId,
          expiresAt: new Date(checkedAt.getTime() + 7 * 24 * 60 * 60 * 1000)
        },
        select: { id: true, email: true, role: true, expiresAt: true }
      });
      await writeSecurityAuditEvent(transaction, {
        workspaceId,
        actorUserId,
        eventKind: 'workspace_invitation_created',
        metadata: { invitation_id: invitation.id }
      });
      return { ...invitation, role: invitation.role as IssuedInvitationRecord['role'] };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async revoke({ workspaceId, actorUserId, invitationId }: {
    workspaceId: string;
    actorUserId: string;
    invitationId: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, workspaceId);
      const actor = await this.lockIssuerMembership(transaction, workspaceId, actorUserId);
      if (actor.role !== 'owner' && actor.role !== 'admin') {
        throw new ApiError(403, 'forbidden', 'You cannot revoke invitations for this workspace');
      }

      const invitations = await transaction.$queryRaw<LockedRevokeInvitation[]>`
        SELECT id::text AS id, role, redeemed_at, revoked_at, expires_at
        FROM invitations
        WHERE workspace_id = ${workspaceId}::uuid AND id = ${invitationId}::uuid
        FOR UPDATE`;
      const invitation = invitations[0];
      if (!invitation) throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      if (actor.role === 'admin' && invitation.role !== 'member') {
        throw new ApiError(403, 'forbidden', 'Administrators can revoke member invitations only');
      }
      if (invitation.redeemed_at) {
        throw new ApiError(409, 'invitation_redeemed', 'A redeemed invitation cannot be revoked');
      }
      if (invitation.revoked_at) return;
      const nowRows = await transaction.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (!nowRows[0] || invitation.expires_at <= nowRows[0].now) {
        throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      }

      const updated = await transaction.$executeRaw`
        UPDATE invitations
        SET revoked_at = clock_timestamp()
        WHERE workspace_id = ${workspaceId}::uuid
          AND id = ${invitationId}::uuid
          AND redeemed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`;
      if (updated !== 1) throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      await writeSecurityAuditEvent(transaction, {
        workspaceId,
        actorUserId,
        eventKind: 'workspace_invitation_revoked',
        metadata: { invitation_id: invitation.id }
      });
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async redeem({ userId, tokenHash }: { userId: string; tokenHash: Buffer }): Promise<RedeemInvitationResult> {
    const prismaTokenHash = Uint8Array.from(tokenHash);
    return this.prisma.$transaction(async (transaction) => {
      const discovered = await transaction.$queryRaw<Array<{ workspace_id: string }>>`
        SELECT workspace_id::text AS workspace_id
        FROM invitations
        WHERE token_hash = ${prismaTokenHash}`;
      const workspaceId = discovered[0]?.workspace_id;
      if (!workspaceId) throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      await this.lockWorkspace(transaction, workspaceId);

      const rows = await transaction.$queryRaw<LockedInvitation[]>`
        SELECT i.id::text AS id, i.workspace_id::text AS workspace_id, i.role,
               i.email, i.redeemed_at, i.revoked_at, i.expires_at,
               u.email AS user_email, u.email_verified_at, u.status AS user_status
        FROM invitations AS i
        JOIN users AS u ON u.id = ${userId}::uuid
        WHERE i.workspace_id = ${workspaceId}::uuid AND i.token_hash = ${prismaTokenHash}
        FOR UPDATE OF i, u`;
      const invitation = rows[0];
      if (!invitation || invitation.redeemed_at || invitation.revoked_at) {
        throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      }
      const nowRows = await transaction.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (!nowRows[0] || invitation.expires_at <= nowRows[0].now) {
        throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      }
      if (invitation.user_status !== 'active') {
        throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      }
      if (!invitation.email_verified_at || normalizeEmail(invitation.email) !== normalizeEmail(invitation.user_email)) {
        throw new ApiError(403, 'invitation_email_mismatch', 'A verified invited email is required');
      }
      try {
        await transaction.workspaceMembership.create({
          data: { workspaceId: invitation.workspace_id, userId, role: invitation.role }
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'already_a_member', 'User is already a workspace member');
        throw error;
      }
      const consumed = await transaction.$executeRaw`
        UPDATE invitations
        SET redeemed_at = clock_timestamp()
        WHERE id = ${invitation.id}::uuid
          AND redeemed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`;
      if (consumed !== 1) throw new ApiError(404, 'invitation_unavailable', 'Invitation is unavailable');
      await writeSecurityAuditEvent(transaction, {
        workspaceId: invitation.workspace_id,
        actorUserId: userId,
        eventKind: 'workspace_membership_added',
        metadata: { target_user_id: userId, role_after: invitation.role }
      });
      await writeSecurityAuditEvent(transaction, {
        workspaceId: invitation.workspace_id,
        actorUserId: userId,
        eventKind: 'workspace_invitation_redeemed',
        metadata: { invitation_id: invitation.id }
      });
      return { workspaceId: invitation.workspace_id, role: invitation.role };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  private async lockWorkspace(transaction: Prisma.TransactionClient, workspaceId: string): Promise<void> {
    const rows = await transaction.$queryRaw<InvitationWorkspace[]>`
      SELECT id::text AS id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
  }

  private async lockIssuerMembership(transaction: Prisma.TransactionClient, workspaceId: string, actorUserId: string): Promise<LockedIssuerMembership> {
    const rows = await transaction.$queryRaw<LockedIssuerMembership[]>`
      SELECT wm.role
      FROM users AS u
      JOIN workspace_memberships AS wm ON wm.user_id = u.id
      WHERE wm.workspace_id = ${workspaceId}::uuid
        AND wm.user_id = ${actorUserId}::uuid
        AND u.status = 'active'
      FOR UPDATE OF u, wm`;
    const membership = rows[0];
    if (!membership) throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
    return membership;
  }
}
