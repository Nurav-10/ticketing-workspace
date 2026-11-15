import { timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { IssueDomainError, type CreateIssueCommand, type IssuePriority, type IssueScope, type IssueStatus, type IssueSummary } from './issue-domain.js';
import type {
  AuthorizedIssueListQuery, AuthorizedIssueMutation, AuthorizedIssuePatch, IssueActivityMetadata,
  IssueActivityRecord, IssueDetail, IssuePage, IssueRepository,
} from './issue-repository.js';

const OPERATION = 'issue.create';
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
type Tx = Prisma.TransactionClient;
type VisiblePerson = { displayName: string; status: string; memberships: Array<{ teams: Array<{ teamId: string }> }> };
type Row = { id: string; workspaceId: string; teamId: string; issueNumber: number; title: string; description: string | null; status: string; workflowStatusId: string | null; priority: string; assigneeUserId: string | null; createdByUserId: string; version: number; createdAt: Date; updatedAt: Date; archivedAt: Date | null; team: { key: string; visibility: string }; assignee: VisiblePerson | null };
type Cursor = { at: string; id: string };
interface LockedTeam { id: string; visibility: string; }
interface LockedIssue { id: string; }
interface AllocatedNumber { issue_number: number; }

function issueSummaryInclude(workspaceId: string, teamId: string) {
  return {
    team: { select: { key: true, visibility: true } },
    assignee: { select: {
      displayName: true,
      status: true,
      memberships: { where: { workspaceId }, select: { teams: { where: { teamId }, select: { teamId: true } } } },
    } },
  } satisfies Prisma.IssueInclude;
}

function issueError(code: ConstructorParameters<typeof IssueDomainError>[0], message: string): never {
  throw new IssueDomainError(code, message);
}
function visiblePerson(person: VisiblePerson | null, id: string | null, visibility: string): { id: string; displayName: string } | null {
  if (!person || !id || person.status !== 'active' || person.memberships.length === 0) return null;
  if (visibility === 'private' && !person.memberships.some((membership) => membership.teams.length > 0)) return null;
  if (visibility !== 'private' && visibility !== 'workspace') return null;
  return { id, displayName: person.displayName };
}
function summary(row: Row): IssueSummary {
  return { id: row.id, workspaceId: row.workspaceId, teamId: row.teamId, issueNumber: row.issueNumber,
    key: `${row.team.key}-${row.issueNumber}`, title: row.title, description: row.description,
    status: row.status as IssueStatus, workflowStatusId: row.workflowStatusId, priority: row.priority as IssuePriority, assigneeUserId: row.assigneeUserId,
    assignee: visiblePerson(row.assignee, row.assigneeUserId, row.team.visibility),
    createdByUserId: row.createdByUserId, version: row.version, createdAt: row.createdAt,
    updatedAt: row.updatedAt, archivedAt: row.archivedAt };
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || typeof parsed.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)) throw new Error();
    return { at: new Date(parsed.at).toISOString(), id: parsed.id };
  } catch { return issueError('invalid_issue_input', 'Cursor is invalid'); }
}
function hashBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return issueError('invalid_issue_input', 'Payload hash is invalid');
  return Buffer.from(hex, 'hex');
}
function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function errorNotFound(): never { return issueError('issue_not_found', 'Issue not found'); }

/** PostgreSQL-backed issue persistence. Every access check and mutation is tenant scoped. */
export class PrismaIssueRepository implements IssueRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Maintenance hook; operators can repeat bounded batches until a short batch is returned. */
  async deleteExpiredIdempotencyRecords(limit = 500): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error('Invalid idempotency cleanup batch size');
    return this.prisma.$executeRaw`
      DELETE FROM issue_idempotency_records
      WHERE id IN (
        SELECT id FROM issue_idempotency_records
        WHERE expires_at <= clock_timestamp()
        ORDER BY expires_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) AND expires_at <= clock_timestamp()`;
  }

  async createAuthorized(command: CreateIssueCommand): Promise<IssueSummary> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorkspace(tx, command.workspaceId);
      const team = await this.lockTeam(tx, command.workspaceId, command.teamId);
      await this.lockUsers(tx, [command.actorUserId, ...(command.assigneeUserId ? [command.assigneeUserId] : [])]);
      await this.lockActor(tx, command.workspaceId, command.actorUserId, command.teamId, team.visibility);
      if (command.assigneeUserId) await this.requireAssignee(tx, command.workspaceId, command.teamId, team.visibility, command.assigneeUserId);

      // The actor's locked user row serializes this actor's keys, including an
      // absent key. Lock an existing record before checking expiry or reuse.
      await tx.$queryRaw`SELECT id FROM issue_idempotency_records WHERE workspace_id = ${command.workspaceId}::uuid AND actor_user_id = ${command.actorUserId}::uuid AND operation = ${OPERATION} AND key = ${command.idempotencyKey} FOR UPDATE`;
      const existing = await tx.issueIdempotencyRecord.findUnique({
        where: { workspaceId_actorUserId_operation_key: { workspaceId: command.workspaceId, actorUserId: command.actorUserId, operation: OPERATION, key: command.idempotencyKey } },
      });
      if (existing) {
        const active = await tx.$queryRaw<Array<{ active: boolean }>>`SELECT (${existing.expiresAt} > clock_timestamp()) AS active`;
        if (active[0]?.active) {
          if (!sameHash(existing.payloadHash, hashBytes(command.payloadHash))) issueError('issue_idempotency_conflict', 'Idempotency key was already used for a different request');
          const linked = await this.findVisibleIssue(tx, command, existing.issueId, false);
          if (!linked) errorNotFound();
          return summary(linked);
        }
        await tx.issueIdempotencyRecord.delete({ where: { id: existing.id } });
      }

      const allocated = await tx.$queryRaw<AllocatedNumber[]>`
        UPDATE teams SET next_issue_number = next_issue_number + 1
        WHERE workspace_id = ${command.workspaceId}::uuid AND id = ${command.teamId}::uuid
          AND next_issue_number < 2147483647
        RETURNING next_issue_number - 1 AS issue_number`;
      if (!allocated[0]) issueError('issue_number_exhausted', 'This team has no available issue numbers');
      const defaultStatus = await tx.workflowStatus.findFirst({
        where: { workspaceId: command.workspaceId, teamId: command.teamId, isDefault: true, isRetired: false },
        select: { id: true },
      });
      const issue = await tx.issue.create({ data: {
        workspaceId: command.workspaceId, teamId: command.teamId, issueNumber: allocated[0].issue_number,
        title: command.title, description: command.description, priority: command.priority,
        workflowStatusId: defaultStatus?.id ?? null,
        assigneeUserId: command.assigneeUserId, createdByUserId: command.actorUserId,
      }, include: issueSummaryInclude(command.workspaceId, command.teamId) });
      await this.writeActivity(tx, issue, command.actorUserId, 'created', {});
      await this.writeOutbox(tx, issue, 'issue.created');
      const idempotencyTimes = await tx.$queryRaw<Array<{ created_at: Date; expires_at: Date }>>`SELECT sample.created_at, sample.created_at + (${command.idempotencyRetentionMs} * interval '1 millisecond') AS expires_at FROM (SELECT clock_timestamp() AS created_at) AS sample`;
      const idempotencyTime = idempotencyTimes[0];
      if (!idempotencyTime) throw new Error('Database clock unavailable');
      await tx.issueIdempotencyRecord.create({ data: {
        workspaceId: command.workspaceId, teamId: command.teamId, actorUserId: command.actorUserId,
        operation: OPERATION, key: command.idempotencyKey, payloadHash: Uint8Array.from(hashBytes(command.payloadHash)),
        issueId: issue.id, response: { issue_id: issue.id }, createdAt: idempotencyTime.created_at, expiresAt: idempotencyTime.expires_at,
      } });
      return summary(issue);
    }, TX_OPTIONS);
  }

  async listAuthorized(query: AuthorizedIssueListQuery): Promise<IssuePage> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.issue.findMany({
      where: { workspaceId: query.workspaceId, teamId: query.teamId, archivedAt: query.archived ? { not: null } : null,
        workspace: { memberships: { some: { userId: query.actorUserId, user: { status: 'active' } } } },
        team: { OR: [{ visibility: 'workspace' }, { visibility: 'private', memberships: { some: { workspaceId: query.workspaceId, userId: query.actorUserId } } }] },
        ...(query.status ? { status: query.status } : {}), ...(query.priority ? { priority: query.priority } : {}),
        ...(query.assigneeUserId ? { assigneeUserId: query.assigneeUserId } : {}),
        ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {}),
      }, include: issueSummaryInclude(query.workspaceId, query.teamId), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return { items: page.map((row) => summary(row as Row)), ...(hasMore && page.length ? { nextCursor: encodeCursor({ at: page.at(-1)!.createdAt.toISOString(), id: page.at(-1)!.id }) } : {}) };
  }

  async getAuthorized(input: IssueScope & { actorUserId: string; issueId: string; activityLimit?: number; activityCursor?: string }): Promise<IssueDetail> {
    const cursor = decodeCursor(input.activityCursor);
    const issue = await this.findVisibleIssue(this.prisma, input, input.issueId, false);
    if (!issue) errorNotFound();
    const limit = input.activityLimit ?? 50;
    const events = await this.prisma.issueActivityEvent.findMany({
      where: { workspaceId: input.workspaceId, teamId: input.teamId, issueId: input.issueId,
        issue: { workspace: { memberships: { some: { userId: input.actorUserId, user: { status: 'active' } } } },
          team: { OR: [{ visibility: 'workspace' }, { visibility: 'private', memberships: { some: { workspaceId: input.workspaceId, userId: input.actorUserId } } }] } },
        ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {}) },
      include: { actor: { select: { displayName: true, status: true, memberships: { where: { workspaceId: input.workspaceId }, select: { teams: { where: { teamId: input.teamId }, select: { teamId: true } } } } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const hasMore = events.length > limit;
    const page = events.slice(0, limit);
    const activity: IssueActivityRecord[] = page.map((e) => ({ id: e.id, issueId: e.issueId, actorUserId: e.actorUserId,
      actor: visiblePerson(e.actor, e.actorUserId, issue.team.visibility),
      kind: e.eventKind as IssueActivityRecord['kind'], metadata: e.metadata as IssueActivityMetadata, createdAt: e.createdAt }));
    return { issue: summary(issue), activity, ...(hasMore && page.length ? { nextActivityCursor: encodeCursor({ at: page.at(-1)!.createdAt.toISOString(), id: page.at(-1)!.id }) } : {}) };
  }

  async updateAuthorized(input: AuthorizedIssuePatch): Promise<IssueSummary> {
    return this.mutate(input, async (tx, current, team) => {
      const { changes } = input;
      if (current.version !== input.expectedVersion || current.archivedAt) {
        issueError('issue_version_conflict', 'Issue has changed; reload before applying this action');
      }
      const actualChanges = Object.fromEntries(Object.entries(changes).filter(([field, value]) => current[field as keyof Row] !== value)) as typeof changes;
      if (Object.keys(actualChanges).length === 0) return summary(current);
      if (actualChanges.assigneeUserId) await this.requireAssignee(tx, input.workspaceId, input.teamId, team.visibility, actualChanges.assigneeUserId);
      const data: Prisma.IssueUpdateManyMutationInput = { ...actualChanges, version: { increment: 1 }, updatedAt: new Date() };
      const result = await tx.issue.updateMany({ where: { id: input.issueId, workspaceId: input.workspaceId, teamId: input.teamId, version: input.expectedVersion, archivedAt: null }, data });
      if (!result.count) return this.casConflict(tx, input);
      const after = await this.scopedIssue(tx, input, input.issueId, true);
      const changedFields = Object.keys(actualChanges) as Array<'title' | 'description' | 'priority' | 'assigneeUserId'>;
      await this.writeActivity(tx, after, input.actorUserId, 'fields_changed', { changedFields,
        ...(actualChanges.priority !== undefined ? { priorityBefore: current.priority, priorityAfter: after.priority } : {}),
        ...(Object.hasOwn(actualChanges, 'assigneeUserId') ? { assigneeBefore: current.assigneeUserId, assigneeAfter: after.assigneeUserId } : {}) });
      await this.writeOutbox(tx, after, 'issue.updated');
      return summary(after);
    }, input.changes.assigneeUserId ?? undefined);
  }

  async transitionAuthorized(input: AuthorizedIssueMutation & { targetStatus: IssueStatus; allowedFromStatuses: readonly IssueStatus[] }): Promise<IssueSummary> {
    return this.mutate(input, async (tx, current) => {
      if (current.version !== input.expectedVersion) issueError('issue_version_conflict', 'Issue has changed; reload before applying this action');
      if (current.archivedAt || !input.allowedFromStatuses.includes(current.status as IssueStatus)) issueError('issue_invalid_transition', 'Issue cannot make that status change');
      const targetWorkflowStatus = await tx.workflowStatus.findFirst({
        where: { workspaceId: input.workspaceId, teamId: input.teamId, key: input.targetStatus, isRetired: false },
        select: { id: true },
      });
      const changed = await tx.issue.updateMany({
        where: { id: input.issueId, workspaceId: input.workspaceId, teamId: input.teamId, version: input.expectedVersion, status: { in: [...input.allowedFromStatuses] }, archivedAt: null },
        data: {
          status: input.targetStatus,
          ...(targetWorkflowStatus ? { workflowStatusId: targetWorkflowStatus.id } : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (!changed.count) return this.casConflict(tx, input);
      const after = await this.scopedIssue(tx, input, input.issueId, true);
      await this.writeActivity(tx, after, input.actorUserId, 'status_changed', { statusBefore: current.status as IssueStatus, statusAfter: input.targetStatus });
      await this.writeOutbox(tx, after, 'issue.updated'); return summary(after);
    });
  }

  async setArchivedAuthorized(input: AuthorizedIssueMutation & { archived: boolean }): Promise<IssueSummary> {
    return this.mutate(input, async (tx, current) => {
      if (current.version !== input.expectedVersion || Boolean(current.archivedAt) === input.archived) issueError('issue_version_conflict', 'Issue has changed; reload before applying this action');
      const changed = await tx.issue.updateMany({ where: { id: input.issueId, workspaceId: input.workspaceId, teamId: input.teamId, version: input.expectedVersion, ...(input.archived ? { archivedAt: null } : { archivedAt: { not: null } }) }, data: { archivedAt: input.archived ? new Date() : null, version: { increment: 1 }, updatedAt: new Date() } });
      if (!changed.count) return this.casConflict(tx, input);
      const after = await this.scopedIssue(tx, input, input.issueId, false);
      await this.writeActivity(tx, after, input.actorUserId, input.archived ? 'archived' : 'restored', {});
      await this.writeOutbox(tx, after, input.archived ? 'issue.archived' : 'issue.restored'); return summary(after);
    });
  }

  private async mutate(input: AuthorizedIssueMutation, action: (tx: Tx, current: Row, team: LockedTeam) => Promise<IssueSummary>, targetUserId?: string): Promise<IssueSummary> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorkspace(tx, input.workspaceId);
      const team = await this.lockTeam(tx, input.workspaceId, input.teamId);
      await this.lockUsers(tx, [input.actorUserId, ...(targetUserId ? [targetUserId] : [])]);
      await this.lockActor(tx, input.workspaceId, input.actorUserId, input.teamId, team.visibility);
      const lock = await tx.$queryRaw<LockedIssue[]>`SELECT id::text AS id FROM issues WHERE workspace_id = ${input.workspaceId}::uuid AND team_id = ${input.teamId}::uuid AND id = ${input.issueId}::uuid FOR UPDATE`;
      if (!lock[0]) errorNotFound();
      const current = await this.scopedIssue(tx, input, input.issueId, false);
      return action(tx, current, team);
    }, TX_OPTIONS);
  }

  private async findVisibleIssue(client: PrismaClient | Tx, scope: IssueScope & { actorUserId: string }, issueId: string, liveOnly: boolean): Promise<Row | null> {
    return client.issue.findFirst({ where: { id: issueId, workspaceId: scope.workspaceId, teamId: scope.teamId,
      ...(liveOnly ? { archivedAt: null } : {}), workspace: { memberships: { some: { userId: scope.actorUserId, user: { status: 'active' } } } },
      team: { OR: [{ visibility: 'workspace' }, { visibility: 'private', memberships: { some: { workspaceId: scope.workspaceId, userId: scope.actorUserId } } }] },
    }, include: issueSummaryInclude(scope.workspaceId, scope.teamId) }) as Promise<Row | null>;
  }

  private async scopedIssue(client: PrismaClient | Tx, scope: IssueScope, issueId: string, liveOnly: boolean): Promise<Row> {
    const row = await client.issue.findFirst({ where: { id: issueId, workspaceId: scope.workspaceId, teamId: scope.teamId, ...(liveOnly ? { archivedAt: null } : {}) }, include: issueSummaryInclude(scope.workspaceId, scope.teamId) });
    if (!row) errorNotFound(); return row as Row;
  }

  private async casConflict(tx: Tx, input: IssueScope & { issueId: string }): Promise<never> {
    await this.scopedIssue(tx, input, input.issueId, false);
    return issueError('issue_version_conflict', 'Issue has changed; reload before applying this action');
  }

  private async lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM workspaces WHERE id = ${workspaceId}::uuid FOR KEY SHARE`;
    if (!rows[0]) errorNotFound();
  }
  private async lockUsers(tx: Tx, userIds: string[]): Promise<void> {
    const ids = [...new Set(userIds)].sort();
    await tx.$queryRaw`SELECT id FROM users WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  }
  private async lockTeam(tx: Tx, workspaceId: string, teamId: string): Promise<LockedTeam> {
    const rows = await tx.$queryRaw<LockedTeam[]>`SELECT id::text AS id, visibility FROM teams WHERE workspace_id = ${workspaceId}::uuid AND id = ${teamId}::uuid FOR UPDATE`;
    if (!rows[0]) errorNotFound(); return rows[0];
  }
  private async lockActor(tx: Tx, workspaceId: string, actorUserId: string, teamId: string, visibility: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ role: string }>>`SELECT wm.role FROM users u JOIN workspace_memberships wm ON wm.user_id = u.id WHERE wm.workspace_id = ${workspaceId}::uuid AND wm.user_id = ${actorUserId}::uuid AND u.status = 'active' FOR UPDATE OF u, wm`;
    if (!rows[0]) issueError('issue_forbidden', 'You cannot access this team');
    if (visibility === 'private') {
      const membership = await tx.$queryRaw<Array<{ user_id: string }>>`SELECT user_id::text AS user_id FROM team_memberships WHERE workspace_id = ${workspaceId}::uuid AND team_id = ${teamId}::uuid AND user_id = ${actorUserId}::uuid FOR UPDATE`;
      if (!membership[0]) issueError('issue_forbidden', 'You cannot access this team');
    }
  }
  private async requireAssignee(tx: Tx, workspaceId: string, teamId: string, visibility: string, userId: string): Promise<void> {
    const users = await tx.$queryRaw<Array<{ user_id: string }>>`SELECT wm.user_id::text AS user_id FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ${workspaceId}::uuid AND wm.user_id = ${userId}::uuid AND u.status = 'active' FOR UPDATE OF u, wm`;
    if (!users[0]) issueError('issue_assignee_unavailable', 'Assignee is unavailable');
    if (visibility === 'private') {
      const teamMembership = await tx.$queryRaw<Array<{ user_id: string }>>`SELECT user_id::text AS user_id FROM team_memberships WHERE workspace_id = ${workspaceId}::uuid AND team_id = ${teamId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
      if (!teamMembership[0]) issueError('issue_assignee_unavailable', 'Assignee is unavailable');
    }
  }
  private async writeActivity(tx: Tx, issue: Row, actorUserId: string, eventKind: 'created' | 'fields_changed' | 'status_changed' | 'archived' | 'restored', metadata: IssueActivityMetadata): Promise<void> {
      await tx.issueActivityEvent.create({ data: { workspaceId: issue.workspaceId, teamId: issue.teamId, issueId: issue.id, actorUserId, eventKind, metadata: metadata as Prisma.InputJsonValue } });
  }
  private async writeOutbox(tx: Tx, issue: Row, eventKind: string): Promise<void> {
    await tx.outboxEvent.create({ data: { workspaceId: issue.workspaceId, teamId: issue.teamId, issueId: issue.id, eventKind, payload: { issue_id: issue.id, version: issue.version } } });
  }
}
