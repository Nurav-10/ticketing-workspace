import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { decideWorkspaceAction, type WorkspaceAction, type WorkspaceMembershipFact } from '../authorization/policy.js';
import { ApiError } from '../shared/api-error.js';
import { writeSecurityAuditEvent } from '../audit/security-audit-writer.js';
import type { AssignableWorkspaceRole, ChangeMembershipRoleInput, LeaveWorkspaceInput, MembershipMutationInput, MembershipRepository } from './membership-repository.js';

interface LockedWorkspace { id: string; }
interface LockedUser { id: string; status: string; }
interface LockedMembership { user_id: string; role: string; }

type LockedFacts = Map<string, { status: string; role: string | undefined }>;

function asMembership(workspaceId: string, userId: string, fact: { status: string; role: string | undefined } | undefined): WorkspaceMembershipFact | null {
  if (!fact?.role || !['owner', 'admin', 'member'].includes(fact.role)) return null;
  return { workspaceId, userId, role: fact.role as WorkspaceMembershipFact['role'], isActive: fact.status === 'active' };
}

function throwDecisionError(reason: string, target = false): never {
  if (reason === 'not_a_member') throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
  if (reason === 'target_not_in_workspace') throw new ApiError(404, target ? 'member_unavailable' : 'workspace_not_found', target ? 'Workspace member is unavailable' : 'Workspace not found');
  if (reason === 'forbidden') throw new ApiError(403, 'forbidden', 'You cannot manage this workspace membership');
  if (reason === 'owner_transfer_required') throw new ApiError(409, 'owner_transfer_required', 'Transfer ownership before leaving the workspace');
  if (reason === 'target_fact_required') throw new ApiError(404, 'member_unavailable', 'Workspace member is unavailable');
  if (reason === 'target_type_mismatch') throw new ApiError(409, 'membership_target_invalid', 'The requested membership action is not allowed for this target');
  throw new ApiError(403, 'forbidden', 'You cannot manage this workspace membership');
}

function requireDecision(facts: Parameters<typeof decideWorkspaceAction>[0], action: WorkspaceAction, target = false): void {
  const decision = decideWorkspaceAction(facts, action);
  if (!decision.allowed) throwDecisionError(decision.reason, target);
}

/**
 * Workspace membership changes use explicit locks because their authorization depends
 * on mutable roles. SQL is limited to locking current rows and appending immutable
 * audit events; ordinary policy writes continue to use Prisma.
 */
export class PrismaMembershipRepository implements MembershipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async changeRole(input: ChangeMembershipRoleInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const factsByUser = await this.lockActorAndTarget(transaction, input.workspaceId, input.actorUserId, input.targetUserId);
      const actorFact = asMembership(input.workspaceId, input.actorUserId, factsByUser.get(input.actorUserId));
      const targetFact = asMembership(input.workspaceId, input.targetUserId, factsByUser.get(input.targetUserId));
      const action = targetFact?.role === 'member' ? 'changeMemberRole' : 'changeAdminRole';
      const facts = { requestedWorkspaceId: input.workspaceId, actorUserId: input.actorUserId, membership: actorFact, targetUserId: input.targetUserId, targetMembership: targetFact };
      requireDecision(facts, action, true);
      if (targetFact?.role === input.role) throw new ApiError(409, 'membership_role_unchanged', 'Workspace member already has this role');
      await writeSecurityAuditEvent(transaction, {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        eventKind: 'workspace_membership_role_changed',
        metadata: { target_user_id: input.targetUserId, role_before: targetFact!.role, role_after: input.role },
      });
      await transaction.workspaceMembership.updateMany({
        where: { workspaceId: input.workspaceId, userId: input.targetUserId },
        data: { role: input.role }
      });
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async removeMember(input: MembershipMutationInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const factsByUser = await this.lockActorAndTarget(transaction, input.workspaceId, input.actorUserId, input.targetUserId);
      const actorFact = asMembership(input.workspaceId, input.actorUserId, factsByUser.get(input.actorUserId));
      const targetFact = asMembership(input.workspaceId, input.targetUserId, factsByUser.get(input.targetUserId));
      const action = targetFact?.role === 'member' ? 'removeMember' : 'removeAdmin';
      requireDecision({
        requestedWorkspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        membership: actorFact,
        targetUserId: input.targetUserId,
        targetMembership: targetFact
      }, action, true);
      await writeSecurityAuditEvent(transaction, {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        eventKind: 'workspace_membership_removed',
        metadata: { target_user_id: input.targetUserId, role_before: targetFact!.role },
      });
      await transaction.workspaceMembership.deleteMany({ where: { workspaceId: input.workspaceId, userId: input.targetUserId } });
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async transferOwnership(input: MembershipMutationInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const factsByUser = await this.lockActorAndTarget(transaction, input.workspaceId, input.actorUserId, input.targetUserId);
      const actorFact = asMembership(input.workspaceId, input.actorUserId, factsByUser.get(input.actorUserId));
      const targetFact = asMembership(input.workspaceId, input.targetUserId, factsByUser.get(input.targetUserId));
      requireDecision({
        requestedWorkspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        membership: actorFact,
        targetUserId: input.targetUserId,
        targetMembership: targetFact
      }, 'transferOwnership', true);
      if (actorFact?.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only the workspace owner can transfer ownership');

      await writeSecurityAuditEvent(transaction, {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        eventKind: 'workspace_owner_transferred',
        metadata: { previous_owner_user_id: input.actorUserId, new_owner_user_id: input.targetUserId },
      });

      // Demote before promoting so the partial unique owner index remains satisfied
      // at every statement while the deferred trigger checks only final state.
      await transaction.workspaceMembership.updateMany({
        where: { workspaceId: input.workspaceId, userId: input.actorUserId, role: 'owner' },
        data: { role: 'admin' }
      });
      await transaction.workspaceMembership.updateMany({
        where: { workspaceId: input.workspaceId, userId: input.targetUserId },
        data: { role: 'owner' }
      });
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async leaveWorkspace(input: LeaveWorkspaceInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const ids = input.transferToUserId ? [input.actorUserId, input.transferToUserId] : [input.actorUserId];
      const factsByUser = await this.lockUsersAndMemberships(transaction, input.workspaceId, ids);
      const actorFact = asMembership(input.workspaceId, input.actorUserId, factsByUser.get(input.actorUserId));
      if (!actorFact || !actorFact.isActive) throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
      let departingRole = actorFact.role;

      if (actorFact.role === 'owner') {
        if (!input.transferToUserId) throw new ApiError(409, 'owner_transfer_required', 'Transfer ownership in this request before leaving the workspace');
        const targetFact = asMembership(input.workspaceId, input.transferToUserId, factsByUser.get(input.transferToUserId));
        requireDecision({
          requestedWorkspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          membership: actorFact,
          targetUserId: input.transferToUserId,
          targetMembership: targetFact
        }, 'transferOwnership', true);
        await writeSecurityAuditEvent(transaction, {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          eventKind: 'workspace_owner_transferred',
          metadata: { previous_owner_user_id: input.actorUserId, new_owner_user_id: input.transferToUserId },
        });
        await transaction.workspaceMembership.updateMany({
          where: { workspaceId: input.workspaceId, userId: input.actorUserId, role: 'owner' },
          data: { role: 'admin' }
        });
        await transaction.workspaceMembership.updateMany({
          where: { workspaceId: input.workspaceId, userId: input.transferToUserId },
          data: { role: 'owner' }
        });
        departingRole = 'admin';
      } else if (input.transferToUserId) {
        throw new ApiError(400, 'invalid_request', 'Only the current owner can transfer ownership while leaving');
      }

      await writeSecurityAuditEvent(transaction, {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        eventKind: 'workspace_membership_removed',
        metadata: { target_user_id: input.actorUserId, role_before: departingRole },
      });
      await transaction.workspaceMembership.deleteMany({ where: { workspaceId: input.workspaceId, userId: input.actorUserId } });
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  private async lockWorkspace(transaction: Prisma.TransactionClient, workspaceId: string): Promise<void> {
    const rows = await transaction.$queryRaw<LockedWorkspace[]>`
      SELECT id::text AS id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
  }

  private async lockActorAndTarget(transaction: Prisma.TransactionClient, workspaceId: string, actorUserId: string, targetUserId: string): Promise<LockedFacts> {
    return this.lockUsersAndMemberships(transaction, workspaceId, [actorUserId, targetUserId]);
  }

  private async lockUsersAndMemberships(transaction: Prisma.TransactionClient, workspaceId: string, userIds: string[]): Promise<LockedFacts> {
    const ids = [...new Set(userIds)].sort();
    const users = await transaction.$queryRaw<LockedUser[]>`
      SELECT id::text AS id, status
      FROM users
      WHERE id = ANY(${ids}::uuid[])
      ORDER BY id
      FOR UPDATE`;
    const memberships = await transaction.$queryRaw<LockedMembership[]>`
      SELECT user_id::text AS user_id, role
      FROM workspace_memberships
      WHERE workspace_id = ${workspaceId}::uuid
        AND user_id = ANY(${ids}::uuid[])
      ORDER BY user_id
      FOR UPDATE`;
    const roleByUser = new Map(memberships.map(({ user_id, role }) => [user_id, role]));
    return new Map(users.map(({ id, status }) => [id, { status, role: roleByUser.get(id) }]));
  }
}
