import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { BootstrapRepository, CreateBootstrapAccount, BootstrapResult } from './bootstrap-repository.js';
import { writeSecurityAuditEvent } from '../audit/security-audit-writer.js';

const BOOTSTRAP_LOCK_NAMESPACE = 1_112_757_328; // ASCII "BSTP"
const BOOTSTRAP_LOCK_KEY = 1;

function isExpectedUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target: unknown = error.meta?.target;
  if (target === 'user_identities_issuer_subject_key' || target === 'workspaces_slug_key') return true;
  if (!Array.isArray(target)) return false;
  return (target.length === 2 && target.includes('issuer') && target.includes('subject'))
    || (target.length === 1 && target[0] === 'slug');
}

export class PrismaBootstrapRepository implements BootstrapRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createFirstWorkspace(input: CreateBootstrapAccount): Promise<BootstrapResult> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        // Every bootstrap attempt takes this transaction-scoped advisory lock before
        // checking the global invariant. It is intentionally separate from row locks.
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_NAMESPACE}, ${BOOTSTRAP_LOCK_KEY})
        `;

        const existingWorkspace = await transaction.workspace.findFirst({ select: { id: true } });
        if (existingWorkspace) return { kind: 'unavailable' };

        // This exact key check prevents bootstrap from attaching an already-known
        // provider identity to a newly created internal account or workspace.
        const existingIdentity = await transaction.userIdentity.findUnique({
          where: { issuer_subject: { issuer: input.identity.issuer, subject: input.identity.subject } },
          select: { id: true },
        });
        if (existingIdentity) return { kind: 'unavailable' };

        const clock = await transaction.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS now
        `;
        const now = clock[0]?.now;
        if (!now) throw new Error('Database clock unavailable during bootstrap');

        const user = await transaction.user.create({
          data: {
            providerSubject: null,
            email: input.identity.email!,
            emailVerifiedAt: now,
            displayName: input.identity.displayName || input.identity.email!,
            status: 'active',
          },
          select: { id: true },
        });
        await transaction.userIdentity.create({
          data: {
            userId: user.id,
            issuer: input.identity.issuer,
            subject: input.identity.subject,
            providerEmail: input.identity.email,
            providerEmailVerified: true,
            createdAt: now,
            lastAuthenticatedAt: now,
          },
        });
        const workspace = await transaction.workspace.create({
          data: { name: input.workspace.name.trim(), slug: input.workspace.slug },
          select: { id: true },
        });
        await transaction.workspaceMembership.create({
          data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
        });
        await writeSecurityAuditEvent(transaction, {
          workspaceId: workspace.id, actorUserId: user.id,
          eventKind: 'workspace_membership_added',
          metadata: { target_user_id: user.id, role_after: 'owner' },
        });

        return { kind: 'created', userId: user.id, workspaceId: workspace.id };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 });
    } catch (error) {
      if (isExpectedUniqueConflict(error)) return { kind: 'unavailable' };
      throw error;
    }
  }
}
