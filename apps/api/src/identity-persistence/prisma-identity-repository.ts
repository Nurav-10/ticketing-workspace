import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { writeSecurityAuditEvent } from '../audit/security-audit-writer.js';
import type {
  IdentityRepository,
  IdentityResolution,
  InvitationProvisioningGrant,
  ValidatedProviderIdentity,
} from './identity-repository.js';

interface ExistingIdentityRow {
  id: string;
  userId: string;
  userStatus: string;
}

interface InvitationRow {
  id: string;
  workspaceId: string;
  email: string;
  role: string;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}

interface InvitationWorkspaceRow {
  id: string;
}

function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isIdentityUniqueConflict(error: unknown): boolean {
  // Adapter versions expose constraint details in different meta shapes. The
  // catch path independently re-resolves the exact issuer/subject before it
  // treats any uniqueness conflict as a concurrent identity creation.
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class PrismaIdentityRepository implements IdentityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(identity: ValidatedProviderIdentity): Promise<IdentityResolution> {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await this.findExisting(transaction, identity);
      if (!existing) return { kind: 'provisioning_required' };
      if (existing.userStatus !== 'active') return { kind: 'account_disabled' };
      await transaction.$executeRaw`
        UPDATE user_identities
        SET last_authenticated_at = clock_timestamp(),
            provider_email = ${identity.email},
            provider_email_verified = ${identity.emailVerified}
        WHERE id = ${existing.id}::uuid
      `;
      return { kind: 'resolved', userId: existing.userId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async provisionFromInvitation(
    identity: ValidatedProviderIdentity,
    grant: InvitationProvisioningGrant,
  ): Promise<IdentityResolution> {
    if (!grant || grant.kind !== 'invitation' || !Buffer.isBuffer(grant.tokenHash) || grant.tokenHash.byteLength !== 32) {
      return { kind: 'invitation_unavailable' };
    }
    const tokenHash = Uint8Array.from(grant.tokenHash);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await this.findExisting(transaction, identity);
        if (existing) {
          if (existing.userStatus !== 'active') return { kind: 'account_disabled' };
          // A concurrent login created the identity after the caller's lookup.
          // Retry through the existing-identity flow so this invitation is not lost.
          return { kind: 'retryable_conflict' };
        }

        // Invitation operations consistently lock workspace first, then invitation.
        // Discovery by the possession hash is only a locator; re-check the digest,
        // workspace, and invitation state after taking those locks.
        const discovered = await transaction.$queryRaw<InvitationWorkspaceRow[]>`
          SELECT workspace_id::text AS id
          FROM invitations
          WHERE token_hash = ${tokenHash}
        `;
        const workspaceId = discovered[0]?.id;
        if (!workspaceId) {
          const raced = await this.findExisting(transaction, identity);
          if (raced) return raced.userStatus === 'active'
            ? { kind: 'retryable_conflict' }
            : { kind: 'account_disabled' };
          return { kind: 'invitation_unavailable' };
        }
        const workspace = await transaction.$queryRaw<InvitationWorkspaceRow[]>`
          SELECT id::text AS id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE
        `;
        if (!workspace[0]) return { kind: 'invitation_unavailable' };
        const invitations = await transaction.$queryRaw<InvitationRow[]>`
          SELECT id::text AS id, workspace_id::text AS "workspaceId", email, role,
                 redeemed_at AS "redeemedAt", revoked_at AS "revokedAt", expires_at AS "expiresAt"
          FROM invitations
          WHERE workspace_id = ${workspaceId}::uuid AND token_hash = ${tokenHash}
          FOR UPDATE
        `;
        const invitation = invitations[0];
        const decisionTime = await transaction.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS now
        `;
        const now = decisionTime[0]?.now;
        const invitationValid = invitation
          && now
          && !invitation.redeemedAt
          && !invitation.revokedAt
          && invitation.expiresAt > now
          && identity.email !== null
          && identity.emailVerified === true
          && normalizeInvitationEmail(invitation.email) === normalizeInvitationEmail(identity.email);

        if (!invitationValid || !invitation) {
          // A concurrent first-login must retry through existing-identity redemption.
          const raced = await this.findExisting(transaction, identity);
          if (raced) return raced.userStatus === 'active'
            ? { kind: 'retryable_conflict' }
            : { kind: 'account_disabled' };
          return { kind: 'invitation_unavailable' };
        }

        const user = await transaction.user.create({
          data: {
            providerSubject: null,
            email: identity.email!,
            emailVerifiedAt: now,
            displayName: identity.displayName || identity.email!,
            status: 'active',
          },
          select: { id: true },
        });
        const userId = user.id;

        await transaction.userIdentity.create({
          data: {
            userId,
            issuer: identity.issuer,
            subject: identity.subject,
            providerEmail: identity.email,
            providerEmailVerified: true,
            createdAt: now,
            lastAuthenticatedAt: now,
          },
        });

        await transaction.workspaceMembership.create({
          data: { workspaceId: invitation.workspaceId, userId, role: invitation.role },
        });
        const consumed = await transaction.$executeRaw`
          UPDATE invitations
          SET redeemed_at = clock_timestamp()
          WHERE id = ${invitation.id}::uuid
            AND redeemed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > clock_timestamp()
        `;
        if (consumed !== 1) throw new Error('Invitation provisioning lost its locked row');
        await writeSecurityAuditEvent(transaction, {
          workspaceId: invitation.workspaceId, actorUserId: userId,
          eventKind: 'workspace_invitation_redeemed', metadata: { invitation_id: invitation.id },
        });
        await writeSecurityAuditEvent(transaction, {
          workspaceId: invitation.workspaceId, actorUserId: userId,
          eventKind: 'workspace_membership_added', metadata: { target_user_id: userId, role_after: invitation.role },
        });
        return { kind: 'resolved', userId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 });
    } catch (error) {
      if (!isIdentityUniqueConflict(error)) throw error;
      const raced = await this.resolve(identity);
      if (raced.kind === 'account_disabled') return raced;
      if (raced.kind === 'resolved') return { kind: 'retryable_conflict' };
      throw error;
    }
  }

  private async findExisting(
    transaction: Prisma.TransactionClient,
    identity: ValidatedProviderIdentity,
  ): Promise<ExistingIdentityRow | null> {
    const rows = await transaction.$queryRaw<ExistingIdentityRow[]>`
      SELECT i.id::text AS id, i.user_id::text AS "userId", u.status AS "userStatus"
      FROM user_identities AS i
      JOIN users AS u ON u.id = i.user_id
      WHERE i.issuer = ${identity.issuer} AND i.subject = ${identity.subject}
      FOR UPDATE OF i
    `;
    return rows[0] ?? null;
  }
}
