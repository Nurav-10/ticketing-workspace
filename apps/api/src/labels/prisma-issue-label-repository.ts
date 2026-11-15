import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { IssueLabelDomainError, type IssueLabelErrorCode } from './issue-label-service.js';
import type { IssueLabelAssignmentResult, IssueLabelReadCommand, IssueLabelRepository, ReplaceIssueLabelsCommand } from './issue-label-repository.js';

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
type Tx = Prisma.TransactionClient;

function issueLabelError(code: IssueLabelErrorCode, message: string): never {
  throw new IssueLabelDomainError(code, message);
}

function notFound(): never {
  return issueLabelError('issue_label_not_found', 'Issue or requested labels are unavailable');
}

function forbidden(): never {
  return issueLabelError('issue_label_forbidden', 'You cannot access this team');
}

function conflict(): never {
  return issueLabelError('issue_label_version_conflict', 'Issue has changed; reload before applying labels');
}

/** PostgreSQL assignment adapter. Authorization, replacement, history and outbox share one transaction. */
export class PrismaIssueLabelRepository implements IssueLabelRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getAuthorized(command: IssueLabelReadCommand): Promise<IssueLabelAssignmentResult> {
    const rows = await this.prisma.$queryRaw<Array<{ version: number; label_ids: string[] }>>`
      SELECT i.version, COALESCE(array_agg(il.label_id::text ORDER BY il.label_id)
        FILTER (WHERE il.label_id IS NOT NULL), ARRAY[]::text[]) AS label_ids
      FROM issues AS i
      JOIN teams AS t ON t.workspace_id = i.workspace_id AND t.id = i.team_id
      JOIN workspace_memberships AS wm ON wm.workspace_id = i.workspace_id AND wm.user_id = ${command.actorUserId}::uuid
      JOIN users AS u ON u.id = wm.user_id AND u.status = 'active'
      LEFT JOIN issue_labels AS il ON il.workspace_id = i.workspace_id AND il.team_id = i.team_id AND il.issue_id = i.id
      WHERE i.workspace_id = ${command.workspaceId}::uuid AND i.team_id = ${command.teamId}::uuid AND i.id = ${command.issueId}::uuid
        AND (t.visibility = 'workspace' OR (t.visibility = 'private' AND EXISTS (
          SELECT 1 FROM team_memberships AS tm
          WHERE tm.workspace_id = t.workspace_id AND tm.team_id = t.id AND tm.user_id = wm.user_id
        )))
      GROUP BY i.id, i.version`;
    const issue = rows[0];
    if (!issue) return notFound();
    return { workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId,
      version: issue.version, labelIds: issue.label_ids };
  }

  async replaceAuthorized(command: ReplaceIssueLabelsCommand): Promise<IssueLabelAssignmentResult> {
    return this.prisma.$transaction(async (tx) => {
      // Match issue mutation lock order so membership revocation, label deletion,
      // and issue writes serialize without allowing cross-tenant lookup leaks.
      await this.lockWorkspace(tx, command.workspaceId);
      const visibility = await this.lockTeam(tx, command.workspaceId, command.teamId);
      await this.lockAndAuthorizeActor(tx, command, visibility);
      await this.lockIssue(tx, command);

      const issue = await tx.issue.findFirst({
        where: { id: command.issueId, workspaceId: command.workspaceId, teamId: command.teamId },
        select: { version: true, archivedAt: true },
      });
      if (!issue) notFound();
      if (issue.version !== command.expectedVersion || issue.archivedAt) return conflict();

      if (command.labelIds.length) {
        const labels = await tx.label.findMany({
          where: { workspaceId: command.workspaceId, teamId: command.teamId, id: { in: [...command.labelIds] } },
          select: { id: true },
        });
        if (labels.length !== command.labelIds.length) notFound();
      }

      const existing = await tx.issueLabel.findMany({
        where: { workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId },
        select: { labelId: true },
      });
      const existingIds = existing.map(({ labelId }) => labelId.toLowerCase()).sort();
      const requested = [...command.labelIds].sort();
      const requestedSet = new Set(requested);
      const existingSet = new Set(existingIds);
      const addedLabelIds = requested.filter((id) => !existingSet.has(id));
      const removedLabelIds = existingIds.filter((id) => !requestedSet.has(id));

      if (addedLabelIds.length === 0 && removedLabelIds.length === 0) {
        return { workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId, version: issue.version, labelIds: existingIds };
      }
      // The database activity contract permits at most 100 identifiers across
      // both arrays. A legacy over-limit set cannot be partially recorded.
      if (addedLabelIds.length + removedLabelIds.length > 100) {
        issueLabelError('invalid_issue_label_input', 'This label change exceeds the activity limit');
      }

      if (removedLabelIds.length) {
        const removed = await tx.issueLabel.deleteMany({
          where: { workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId, labelId: { in: removedLabelIds } },
        });
        if (removed.count !== removedLabelIds.length) return conflict();
      }
      if (addedLabelIds.length) {
        const added = await tx.issueLabel.createMany({
          data: addedLabelIds.map((labelId) => ({ workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId, labelId })),
        });
        if (added.count !== addedLabelIds.length) return conflict();
      }

      const changed = await tx.issue.updateMany({
        where: { id: command.issueId, workspaceId: command.workspaceId, teamId: command.teamId, version: command.expectedVersion, archivedAt: null },
        data: { version: { increment: 1 }, updatedAt: new Date() },
      });
      if (!changed.count) return conflict();
      const version = command.expectedVersion + 1;
      const metadata = { addedLabelIds, removedLabelIds } satisfies Prisma.InputJsonObject;
      await tx.issueActivityEvent.create({ data: {
        workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId,
        actorUserId: command.actorUserId, eventKind: 'labels_changed', metadata,
      } });
      await tx.outboxEvent.create({ data: {
        workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId,
        eventKind: 'issue.updated', payload: { issue_id: command.issueId, version },
      } });

      return { workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId, version, labelIds: requested };
    }, TX_OPTIONS);
  }

  private async lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM workspaces WHERE id = ${workspaceId}::uuid FOR KEY SHARE`;
    if (!rows[0]) notFound();
  }

  private async lockTeam(tx: Tx, workspaceId: string, teamId: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ visibility: string }>>`
      SELECT visibility FROM teams WHERE workspace_id = ${workspaceId}::uuid AND id = ${teamId}::uuid FOR UPDATE`;
    if (!rows[0]) notFound();
    return rows[0].visibility;
  }

  private async lockAndAuthorizeActor(tx: Tx, command: ReplaceIssueLabelsCommand, visibility: string): Promise<void> {
    const memberships = await tx.$queryRaw<Array<{ role: string }>>`
      SELECT wm.role FROM users AS u
      JOIN workspace_memberships AS wm ON wm.user_id = u.id
      WHERE wm.workspace_id = ${command.workspaceId}::uuid
        AND wm.user_id = ${command.actorUserId}::uuid AND u.status = 'active'
      FOR UPDATE OF u, wm`;
    if (!memberships[0]) forbidden();

    if (visibility === 'private') {
      const grants = await tx.$queryRaw<Array<{ user_id: string }>>`
        SELECT user_id::text AS user_id FROM team_memberships
        WHERE workspace_id = ${command.workspaceId}::uuid AND team_id = ${command.teamId}::uuid
          AND user_id = ${command.actorUserId}::uuid
        FOR UPDATE`;
      if (!grants[0]) forbidden();
    } else if (visibility !== 'workspace') {
      forbidden();
    }
  }

  private async lockIssue(tx: Tx, command: ReplaceIssueLabelsCommand): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM issues
      WHERE workspace_id = ${command.workspaceId}::uuid AND team_id = ${command.teamId}::uuid AND id = ${command.issueId}::uuid
      FOR UPDATE`;
    if (!rows[0]) notFound();
  }
}
