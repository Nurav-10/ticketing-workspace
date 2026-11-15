import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { LabelDomainError, type Label } from './label-domain.js';
import type { CreateLabelCommand, DeleteLabelCommand, LabelActorScope, LabelRepository, ListLabelsQuery, UpdateLabelCommand } from './label-repository.js';

type Tx = Prisma.TransactionClient;
type LabelClient = PrismaClient | Tx;
type LabelRow = {
  id: string; workspaceId: string; teamId: string; name: string; normalizedName: string; color: string;
  version: number; createdAt: Date; updatedAt: Date;
};
type LockedMembership = { role: string };
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

function labelError(code: ConstructorParameters<typeof LabelDomainError>[0], message: string): never {
  throw new LabelDomainError(code, message);
}

function notFound(): never { return labelError('label_not_found', 'Label not found'); }
function forbidden(): never { return labelError('label_forbidden', 'You cannot manage labels for this team'); }

function mapRow(row: LabelRow): Label {
  return { id: row.id, workspaceId: row.workspaceId, teamId: row.teamId, name: row.name,
    normalizedName: row.normalizedName, color: row.color, version: row.version,
    createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function readPolicyWhere(scope: LabelActorScope) {
  return {
    workspaceId: scope.workspaceId,
    teamId: scope.teamId,
    team: {
      workspace: { memberships: { some: { userId: scope.actorUserId, user: { status: 'active' } } } },
      OR: [
        { visibility: 'workspace' },
        { visibility: 'private', memberships: { some: { workspaceId: scope.workspaceId, userId: scope.actorUserId } } },
      ],
    },
  };
}

/** Scoped Prisma reads/writes. Raw SQL here is limited to transactional row locks
 * needed to keep membership revocation and team-admin authorization race-safe. */
export class PrismaLabelRepository implements LabelRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAuthorized(query: ListLabelsQuery): Promise<Label[]> {
    const rows = await this.prisma.label.findMany({
      // Reapply the active workspace membership and team visibility/private grant
      // predicates for every page; the cursor is only an ordering boundary.
      where: {
        ...readPolicyWhere(query),
        ...(query.afterId ? { id: { gt: query.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return rows.map((row) => mapRow(row as LabelRow));
  }

  async createAuthorized(command: CreateLabelCommand): Promise<Label> {
    try { return await this.prisma.$transaction(async (tx) => {
      await this.lockAndAuthorizeManager(tx, command);
      const row = await tx.label.create({
        data: {
          workspaceId: command.workspaceId,
          teamId: command.teamId,
          name: command.name,
          normalizedName: command.normalizedName,
          color: command.color,
        },
      });
      return mapRow(row as LabelRow);
    }, TX_OPTIONS); } catch (error) { return this.handleUniqueName(error); }
  }

  async updateAuthorized(command: UpdateLabelCommand): Promise<Label> {
    try { return await this.prisma.$transaction(async (tx) => {
      await this.lockAndAuthorizeManager(tx, command);
      const current = await this.findScoped(tx, command, command.labelId);
      if (current.version !== command.expectedVersion) return this.conflict();
      const changed = await tx.label.updateMany({
        where: { id: command.labelId, workspaceId: command.workspaceId, teamId: command.teamId, version: command.expectedVersion },
        data: {
          version: { increment: 1 },
          updatedAt: new Date(),
          ...(command.changes.name !== undefined ? { name: command.changes.name } : {}),
          ...(command.changes.normalizedName !== undefined ? { normalizedName: command.changes.normalizedName } : {}),
          ...(command.changes.color !== undefined ? { color: command.changes.color } : {}),
        } satisfies Prisma.LabelUpdateManyMutationInput,
      });
      if (!changed.count) return this.conflict();
      return mapRow(await this.findScoped(tx, command, command.labelId));
    }, TX_OPTIONS); } catch (error) { return this.handleUniqueName(error); }
  }

  async deleteAuthorized(command: DeleteLabelCommand): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockAndAuthorizeManager(tx, command);
      const current = await this.findScoped(tx, command, command.labelId);
      if (current.version !== command.expectedVersion) return this.conflict();
      const assignments = await tx.issueLabel.count({
        where: { workspaceId: command.workspaceId, teamId: command.teamId, labelId: command.labelId },
      });
      if (assignments) labelError('label_in_use', 'Remove this label from issues before deleting it');
      const deleted = await tx.label.deleteMany({
        where: { id: command.labelId, workspaceId: command.workspaceId, teamId: command.teamId, version: command.expectedVersion },
      });
      if (!deleted.count) return this.conflict();
    }, TX_OPTIONS);
  }

  private async findScoped(client: LabelClient, scope: LabelActorScope, labelId: string): Promise<LabelRow> {
    const row = await client.label.findFirst({ where: {
      id: labelId, workspaceId: scope.workspaceId, teamId: scope.teamId,
    } });
    if (!row) return notFound();
    return row as LabelRow;
  }

  private conflict(): never {
    return labelError('label_version_conflict', 'Label has changed; reload before applying this action');
  }

  private handleUniqueName(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return labelError('label_name_conflict', 'A label with this name already exists in this team');
    }
    throw error;
  }

  private async lockAndAuthorizeManager(tx: Tx, scope: LabelActorScope): Promise<void> {
    // Lock order follows the workspace -> team -> active membership -> private grant convention.
    const workspaces = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM workspaces WHERE id = ${scope.workspaceId}::uuid FOR KEY SHARE`;
    if (!workspaces[0]) return notFound();

    const teams = await tx.$queryRaw<Array<{ visibility: string }>>`
      SELECT visibility FROM teams
      WHERE workspace_id = ${scope.workspaceId}::uuid AND id = ${scope.teamId}::uuid
      FOR UPDATE`;
    const team = teams[0];
    if (!team) return notFound();

    const memberships = await tx.$queryRaw<LockedMembership[]>`
      SELECT wm.role FROM users AS u
      JOIN workspace_memberships AS wm ON wm.user_id = u.id
      WHERE wm.workspace_id = ${scope.workspaceId}::uuid
        AND wm.user_id = ${scope.actorUserId}::uuid AND u.status = 'active'
      FOR UPDATE OF u, wm`;
    const membership = memberships[0];
    if (!membership) return forbidden();
    if (membership.role !== 'owner' && membership.role !== 'admin') return forbidden();

    if (team.visibility === 'private') {
      const grants = await tx.$queryRaw<Array<{ user_id: string }>>`
        SELECT user_id::text AS user_id FROM team_memberships
        WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid
          AND user_id = ${scope.actorUserId}::uuid
        FOR UPDATE`;
      if (!grants[0]) return forbidden();
    } else if (team.visibility !== 'workspace') {
      return forbidden();
    }
  }
}
