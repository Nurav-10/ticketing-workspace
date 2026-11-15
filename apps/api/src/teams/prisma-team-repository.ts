import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { writeSecurityAuditEvent } from '../audit/security-audit-writer.js';
import { ApiError } from '../shared/api-error.js';
import type { CreateTeamInput, PrivateTeamListInput, PrivateTeamMembershipInput, PrivateTeamRosterInput, TeamManagementPage, TeamMemberManagementRecord, TeamRepository, TeamSummary } from './team-repository.js';

interface LockedWorkspace { id: string; }
interface LockedUser { id: string; status: string; }
interface LockedMembership { user_id: string; role: string; }
interface LockedTeam { id: string; visibility: string; }

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Lists only teams visible to an active workspace member. Both the workspace grant
 * and private-team grant are expressed in the same tenant-scoped Prisma query so
 * callers cannot turn an authorization decision into a second, unscoped lookup.
 */
export class PrismaTeamRepository implements TeamRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listVisibleToUser(workspaceId: string, userId: string): Promise<TeamSummary[]> {
    const rows = await this.prisma.team.findMany({
      where: {
        workspaceId,
        workspace: { memberships: { some: { userId } } },
        OR: [
          { visibility: 'workspace' },
          { visibility: 'private', memberships: { some: { workspaceId, userId } } }
        ]
      },
      select: { id: true, name: true, key: true, visibility: true },
      orderBy: [{ key: 'asc' }, { id: 'asc' }]
    });

    // PostgreSQL constrains this column to the two supported visibility values.
    return rows.map((row) => ({ ...row, visibility: row.visibility as TeamSummary['visibility'] }));
  }

  async createForAdministrator(input: CreateTeamInput): Promise<TeamSummary> {
    return this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const actor = await this.lockActor(transaction, input.workspaceId, input.actorUserId);
      this.requireAdministrator(actor.role);
      try {
        const team = await transaction.team.create({
          data: { workspaceId: input.workspaceId, name: input.name, key: input.key, visibility: input.visibility },
          select: { id: true, name: true, key: true, visibility: true }
        });
        await writeSecurityAuditEvent(transaction, {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          eventKind: 'team_created',
          metadata: { team_id: team.id }
        });
        return { ...team, visibility: team.visibility as TeamSummary['visibility'] };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'team_key_exists', 'A team with this key already exists');
        throw error;
      }
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async addPrivateMember(input: PrivateTeamMembershipInput): Promise<void> {
    await this.changePrivateMembership(input, 'add');
  }

  async removePrivateMember(input: PrivateTeamMembershipInput): Promise<void> {
    await this.changePrivateMembership(input, 'remove');
  }

  async listPrivateMembersForAdministrator(input: PrivateTeamRosterInput): Promise<TeamManagementPage<TeamMemberManagementRecord>> {
    return this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const actor = await this.lockActor(transaction, input.workspaceId, input.actorUserId);
      this.requireAdministrator(actor.role);
      const teams = await transaction.$queryRaw<LockedTeam[]>`
        SELECT id::text AS id, visibility
        FROM teams
        WHERE workspace_id = ${input.workspaceId}::uuid AND id = ${input.teamId}::uuid
        FOR UPDATE`;
      const team = teams[0];
      if (!team) throw new ApiError(404, 'team_unavailable', 'Team is unavailable');
      if (team.visibility !== 'private') {
        throw new ApiError(409, 'team_not_private', 'Membership can only be managed for private teams');
      }

      const cursor = input.cursor ?? null;
      const rows = await transaction.$queryRaw<Array<{
        id: string;
        email: string;
        display_name: string;
        role: string;
        is_team_member: boolean;
      }>>`
        SELECT u.id::text AS id, u.email, u.display_name, wm.role,
          (tm.user_id IS NOT NULL) AS is_team_member
        FROM workspace_memberships AS wm
        JOIN users AS u ON u.id = wm.user_id
        LEFT JOIN team_memberships AS tm
          ON tm.workspace_id = wm.workspace_id
          AND tm.team_id = ${input.teamId}::uuid
          AND tm.user_id = wm.user_id
        WHERE wm.workspace_id = ${input.workspaceId}::uuid
          AND u.status = 'active'
          AND (${cursor}::uuid IS NULL OR wm.user_id > ${cursor}::uuid)
        ORDER BY wm.user_id ASC
        LIMIT ${input.limit + 1}`;
      const hasMore = rows.length > input.limit;
      const records = rows.slice(0, input.limit).map(({ id, email, display_name, role, is_team_member }) => ({
        id,
        email,
        displayName: display_name,
        role,
        isTeamMember: is_team_member
      }));
      return {
        data: records,
        hasMore,
        nextCursor: hasMore ? records[records.length - 1]!.id : null
      };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async listPrivateTeamsForAdministrator(input: PrivateTeamListInput): Promise<TeamManagementPage<TeamSummary>> {
    return this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const actor = await this.lockActor(transaction, input.workspaceId, input.actorUserId);
      this.requireAdministrator(actor.role);
      const rows = await transaction.team.findMany({
        where: {
          workspaceId: input.workspaceId,
          visibility: 'private',
          ...(input.cursor ? { id: { gt: input.cursor } } : {})
        },
        select: { id: true, name: true, key: true, visibility: true },
        orderBy: { id: 'asc' },
        take: input.limit + 1
      });
      const hasMore = rows.length > input.limit;
      const data = rows.slice(0, input.limit).map((row) => ({ ...row, visibility: row.visibility as TeamSummary['visibility'] }));
      return {
        data,
        hasMore,
        nextCursor: hasMore ? data[data.length - 1]!.id : null
      };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  private async changePrivateMembership(input: PrivateTeamMembershipInput, operation: 'add' | 'remove'): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      const members = await this.lockActorAndTarget(transaction, input.workspaceId, input.actorUserId, input.targetUserId);
      const actor = members.get(input.actorUserId);
      if (!actor || actor.status !== 'active' || !actor.role) {
        throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
      }
      this.requireAdministrator(actor?.role);
      const target = members.get(input.targetUserId);
      if (!target || target.status !== 'active' || !target.role) {
        throw new ApiError(404, 'team_member_unavailable', 'Team member is unavailable');
      }

      const teams = await transaction.$queryRaw<LockedTeam[]>`
        SELECT id::text AS id, visibility
        FROM teams
        WHERE workspace_id = ${input.workspaceId}::uuid AND id = ${input.teamId}::uuid
        FOR UPDATE`;
      const team = teams[0];
      if (!team) throw new ApiError(404, 'team_unavailable', 'Team is unavailable');
      if (team.visibility !== 'private') {
        throw new ApiError(409, 'team_not_private', 'Membership can only be managed for private teams');
      }

      // The workspace and team locks serialize this mutation with team creation and
      // all membership administration in this repository. The row lock also makes
      // removal safe against concurrent removal of the same grant.
      const existing = await transaction.$queryRaw<Array<{ user_id: string }>>`
        SELECT user_id::text AS user_id
        FROM team_memberships
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND team_id = ${input.teamId}::uuid
          AND user_id = ${input.targetUserId}::uuid
        FOR UPDATE`;

      if (operation === 'add') {
        if (existing.length) throw new ApiError(409, 'team_member_exists', 'User is already a member of this team');
        try {
          await transaction.teamMembership.create({
            data: { workspaceId: input.workspaceId, teamId: input.teamId, userId: input.targetUserId }
          });
          await writeSecurityAuditEvent(transaction, {
            workspaceId: input.workspaceId,
            actorUserId: input.actorUserId,
            eventKind: 'team_membership_added',
            metadata: { team_id: input.teamId, target_user_id: input.targetUserId }
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw new ApiError(409, 'team_member_exists', 'User is already a member of this team');
          throw error;
        }
      } else {
        if (!existing.length) throw new ApiError(404, 'team_member_unavailable', 'Team member is unavailable');
        await transaction.teamMembership.deleteMany({
          where: { workspaceId: input.workspaceId, teamId: input.teamId, userId: input.targetUserId }
        });
        await writeSecurityAuditEvent(transaction, {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          eventKind: 'team_membership_removed',
          metadata: { team_id: input.teamId, target_user_id: input.targetUserId }
        });
      }
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  private async lockWorkspace(transaction: Prisma.TransactionClient, workspaceId: string): Promise<void> {
    const rows = await transaction.$queryRaw<LockedWorkspace[]>`
      SELECT id::text AS id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
  }

  private async lockActor(transaction: Prisma.TransactionClient, workspaceId: string, actorUserId: string): Promise<LockedMembership> {
    const rows = await transaction.$queryRaw<LockedMembership[]>`
      SELECT wm.role
      FROM users AS u
      JOIN workspace_memberships AS wm ON wm.user_id = u.id
      WHERE wm.workspace_id = ${workspaceId}::uuid
        AND wm.user_id = ${actorUserId}::uuid
        AND u.status = 'active'
      FOR UPDATE OF u, wm`;
    const actor = rows[0];
    if (!actor) throw new ApiError(404, 'workspace_not_found', 'Workspace not found');
    return actor;
  }

  private async lockActorAndTarget(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    actorUserId: string,
    targetUserId: string
  ): Promise<Map<string, { status: string; role: string | undefined }>> {
    const ids = [...new Set([actorUserId, targetUserId])].sort();
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

  private requireAdministrator(role: string | undefined): void {
    if (role !== 'owner' && role !== 'admin') {
      throw new ApiError(403, 'forbidden', 'Only workspace owners and administrators can manage teams');
    }
  }
}
