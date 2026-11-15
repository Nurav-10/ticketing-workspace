import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { ApiError } from '../shared/api-error.js';
import type { CycleInput, GroupIssueInput, PlanningRepository, ProjectInput } from './planning-types.js';

type Tx = Prisma.TransactionClient;
type Scoped = { workspaceId: string; teamId: string; actorUserId: string };

export class PrismaPlanningRepository implements PlanningRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private async ensureAuthorizedTeam(input: Scoped): Promise<void> {
    const team = await this.prisma.team.findFirst({
      where: {
        id: input.teamId,
        workspaceId: input.workspaceId,
        workspace: { memberships: { some: { userId: input.actorUserId, user: { status: 'active' } } } },
        OR: [
          { visibility: 'workspace' },
          { visibility: 'private', memberships: { some: { workspaceId: input.workspaceId, userId: input.actorUserId } } },
        ],
      },
      select: { id: true },
    });
    if (!team) throw new ApiError(404, 'team_not_found', 'Team not found');
  }

  async listProjects(input: Scoped): Promise<unknown[]> {
    await this.ensureAuthorizedTeam(input);
    const visibleTeam = { workspace: { memberships: { some: { userId: input.actorUserId, user: { status: 'active' } } } },
      OR: [{ visibility: 'workspace' }, { visibility: 'private', memberships: { some: { workspaceId: input.workspaceId, userId: input.actorUserId } } }] };
    return this.prisma.project.findMany({
      where: { workspaceId: input.workspaceId, teamId: input.teamId, team: visibleTeam },
      select: { id: true, workspaceId: true, teamId: true, name: true, description: true, status: true, startAt: true, targetAt: true, createdAt: true, updatedAt: true,
        _count: { select: { issues: { where: { archivedAt: null } } } },
        issues: { where: { archivedAt: null }, select: { status: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
    }).then((projects) => projects.map(({ issues, _count, ...project }) => ({
      ...project, issueCount: _count.issues, completedIssueCount: issues.filter((issue) => issue.status === 'done').length
    })));
  }

  async createProject(input: ProjectInput): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAuthorizedTeam(tx, input);
      if (input.startAt && input.targetAt && input.startAt > input.targetAt) throw new ApiError(400, 'invalid_project_dates', 'Project target must not precede its start');
      return tx.project.create({ data: { workspaceId: input.workspaceId, teamId: input.teamId, createdByUserId: input.actorUserId,
        name: input.name, description: input.description ?? null, status: input.status ?? 'planned', startAt: input.startAt ?? null, targetAt: input.targetAt ?? null },
        select: { id: true, workspaceId: true, teamId: true, name: true, description: true, status: true, startAt: true, targetAt: true, createdAt: true, updatedAt: true } });
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async listCycles(input: Scoped): Promise<unknown[]> {
    await this.ensureAuthorizedTeam(input);
    const visibleTeam = { workspace: { memberships: { some: { userId: input.actorUserId, user: { status: 'active' } } } },
      OR: [{ visibility: 'workspace' }, { visibility: 'private', memberships: { some: { workspaceId: input.workspaceId, userId: input.actorUserId } } }] };
    return this.prisma.cycle.findMany({
      where: { workspaceId: input.workspaceId, teamId: input.teamId, team: visibleTeam },
      select: { id: true, workspaceId: true, teamId: true, name: true, startAt: true, endAt: true, status: true, completedAt: true, createdAt: true, updatedAt: true,
        _count: { select: { issues: { where: { archivedAt: null } } } } },
      orderBy: [{ startAt: 'desc' }, { id: 'asc' }]
    }).then((cycles) => cycles.map(({ _count, ...cycle }) => ({ ...cycle, issueCount: _count.issues })));
  }

  async createCycle(input: CycleInput): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAuthorizedTeam(tx, input);
      try {
        return await tx.cycle.create({ data: { workspaceId: input.workspaceId, teamId: input.teamId, createdByUserId: input.actorUserId,
          name: input.name, startAt: input.startAt, endAt: input.endAt },
          select: { id: true, workspaceId: true, teamId: true, name: true, startAt: true, endAt: true, status: true, completedAt: true, createdAt: true, updatedAt: true } });
      } catch (error) {
        if (
          (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2004' || error.code === 'P2002')) ||
          (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23P01') ||
          (error instanceof Error && error.message.includes('cycles_no_team_overlap'))
        ) {
          throw new ApiError(409, 'cycle_overlap', 'Cycle dates overlap another cycle for this team');
        }
        throw error;
      }
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async groupIssue(input: GroupIssueInput): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAuthorizedTeam(tx, input);
      const current = await tx.issue.findFirst({ where: { id: input.issueId, workspaceId: input.workspaceId, teamId: input.teamId, archivedAt: null }, select: { version: true, projectId: true, cycleId: true } });
      if (!current) throw new ApiError(404, 'issue_not_found', 'Issue not found');
      if (current.version !== input.expectedVersion) throw new ApiError(409, 'version_conflict', 'Issue changed; reload and retry');
      if (input.projectId !== undefined && input.projectId !== null) {
        const project = await tx.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId, teamId: input.teamId }, select: { id: true } });
        if (!project) throw new ApiError(404, 'project_not_found', 'Project not found');
      }
      if (input.cycleId !== undefined && input.cycleId !== null) {
        const cycle = await tx.cycle.findFirst({ where: { id: input.cycleId, workspaceId: input.workspaceId, teamId: input.teamId, status: { not: 'completed' } }, select: { id: true } });
        if (!cycle) throw new ApiError(404, 'cycle_not_found', 'Cycle not found');
      }
      const nextProjectId = input.projectId !== undefined ? input.projectId : current.projectId;
      const nextCycleId = input.cycleId !== undefined ? input.cycleId : current.cycleId;
      if (current.projectId === nextProjectId && current.cycleId === nextCycleId) {
        return tx.issue.findFirstOrThrow({ where: { id: input.issueId, workspaceId: input.workspaceId, teamId: input.teamId },
          select: { id: true, workspaceId: true, teamId: true, projectId: true, cycleId: true, version: true, updatedAt: true } });
      }
      const changed = await tx.issue.updateMany({ where: { id: input.issueId, workspaceId: input.workspaceId, teamId: input.teamId, archivedAt: null, version: input.expectedVersion },
        data: { projectId: nextProjectId, cycleId: nextCycleId, version: { increment: 1 }, updatedAt: new Date() } });
      if (changed.count !== 1) throw new ApiError(409, 'version_conflict', 'Issue changed; reload and retry');
      const issue = await tx.issue.findFirstOrThrow({ where: { id: input.issueId, workspaceId: input.workspaceId, teamId: input.teamId },
        select: { id: true, workspaceId: true, teamId: true, projectId: true, cycleId: true, version: true, updatedAt: true } });
      if (current.projectId !== issue.projectId) {
        await tx.issueActivityEvent.create({ data: { workspaceId: issue.workspaceId, teamId: issue.teamId, issueId: issue.id,
          actorUserId: input.actorUserId, eventKind: 'project_changed', metadata: { changedFields: ['projectId'], projectBefore: current.projectId, projectAfter: issue.projectId } } });
      }
      if (current.cycleId !== issue.cycleId) {
        await tx.issueActivityEvent.create({ data: { workspaceId: issue.workspaceId, teamId: issue.teamId, issueId: issue.id,
          actorUserId: input.actorUserId, eventKind: 'cycle_changed', metadata: { changedFields: ['cycleId'], cycleBefore: current.cycleId, cycleAfter: issue.cycleId } } });
      }
      await tx.outboxEvent.create({ data: { workspaceId: issue.workspaceId, teamId: issue.teamId, issueId: issue.id,
        eventKind: 'issue.updated', payload: { issue_id: issue.id, version: issue.version } } });
      return issue;
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  private async lockAuthorizedTeam(tx: Tx, input: Scoped): Promise<void> {
    const workspaces = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM workspaces WHERE id = ${input.workspaceId}::uuid FOR KEY SHARE`;
    if (!workspaces[0]) throw new ApiError(404, 'team_not_found', 'Team not found');
    const teams = await tx.$queryRaw<Array<{ id: string; visibility: string }>>`SELECT id::text AS id, visibility FROM teams WHERE workspace_id = ${input.workspaceId}::uuid AND id = ${input.teamId}::uuid FOR UPDATE`;
    const team = teams[0];
    if (!team) throw new ApiError(404, 'team_not_found', 'Team not found');
    const members = await tx.$queryRaw<Array<{ role: string }>>`SELECT wm.role FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ${input.workspaceId}::uuid AND wm.user_id = ${input.actorUserId}::uuid AND u.status = 'active' FOR UPDATE OF wm, u`;
    if (!members[0]) throw new ApiError(404, 'team_not_found', 'Team not found');
    if (team.visibility === 'private') {
      const grants = await tx.$queryRaw<Array<{ user_id: string }>>`SELECT user_id::text AS user_id FROM team_memberships WHERE workspace_id = ${input.workspaceId}::uuid AND team_id = ${input.teamId}::uuid AND user_id = ${input.actorUserId}::uuid FOR UPDATE`;
      if (!grants[0]) throw new ApiError(404, 'team_not_found', 'Team not found');
    }
  }
}
