import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { CommentDomainError, type CommentScope } from './comment-domain.js';
import type {
  AuthorizedCommentCreate,
  AuthorizedCommentMutation,
  CommentPage,
  CommentRepository,
  IssueComment,
} from './comment-repository.js';

type Tx = Prisma.TransactionClient;
type CommentRow = Prisma.CommentGetPayload<{ include: { author: { select: { displayName: true } } } }>;
type CommentCursor = { createdAt: string; id: string };
type LockedTeam = { visibility: string };
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

function commentError(code: ConstructorParameters<typeof CommentDomainError>[0], message: string): never {
  throw new CommentDomainError(code, message);
}
function notFound(): never { return commentError('comment_not_found', 'Comment not found'); }

function encodeCursor(value: CommentCursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value: string | undefined): CommentCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Partial<CommentCursor>;
    const date = typeof cursor.createdAt === 'string' ? new Date(cursor.createdAt) : undefined;
    if (!date || !Number.isFinite(date.getTime()) || typeof cursor.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id)
      || Object.keys(parsed).some((key) => key !== 'createdAt' && key !== 'id')) throw new Error();
    return { createdAt: date.toISOString(), id: cursor.id };
  } catch { return commentError('invalid_comment_input', 'Comment cursor is invalid'); }
}

function toComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    teamId: row.teamId,
    issueId: row.issueId,
    authorUserId: row.authorUserId,
    authorDisplayName: row.author.displayName,
    body: row.body,
    format: row.contentFormat,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

/** PostgreSQL-backed comments. Reads keep the complete authorization predicate in the query. */
export class PrismaCommentRepository implements CommentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAuthorized(query: CommentScope & { actorUserId: string; limit: number; cursor?: string }): Promise<CommentPage> {
    const cursor = decodeCursor(query.cursor);
    return this.prisma.$transaction(async (tx) => {
      const issue = await tx.issue.findFirst({ where: {
        id: query.issueId,
        workspaceId: query.workspaceId,
        teamId: query.teamId,
        workspace: { memberships: { some: { userId: query.actorUserId, user: { status: 'active' } } } },
        team: { OR: [
          { visibility: 'workspace' },
          { visibility: 'private', memberships: { some: { workspaceId: query.workspaceId, userId: query.actorUserId } } },
        ] },
      }, select: { id: true } });
      if (!issue) notFound();
      const rows = await tx.comment.findMany({
      where: {
        workspaceId: query.workspaceId,
        teamId: query.teamId,
        issueId: query.issueId,
        deletedAt: null,
        issue: {
          workspace: { memberships: { some: { userId: query.actorUserId, user: { status: 'active' } } } },
          team: { OR: [
            { visibility: 'workspace' },
            { visibility: 'private', memberships: { some: { workspaceId: query.workspaceId, userId: query.actorUserId } } },
          ] },
        },
        ...(cursor ? { OR: [
          { createdAt: { gt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } },
        ] } : {}),
      },
      include: { author: { select: { displayName: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const items = page.map((row) => toComment(row));
      const last = page.at(-1);
      return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) } : {}) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async createAuthorized(command: AuthorizedCommentCreate): Promise<IssueComment> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActorScope(tx, command);
      await this.lockIssue(tx, command, false);
      const row = await tx.comment.create({ data: {
        workspaceId: command.workspaceId,
        teamId: command.teamId,
        issueId: command.issueId,
        authorUserId: command.actorUserId,
        body: command.body,
        contentFormat: command.format,
      }, include: { author: { select: { displayName: true } } } });
      await this.writeActivity(tx, command, row.id, 'comment_created', row.version);
      await this.writeOutbox(tx, command, row.id, 'issue.comment.created', row.version);
      return toComment(row);
    }, TX_OPTIONS);
  }

  async updateAuthorized(command: AuthorizedCommentMutation & { body: string }): Promise<IssueComment> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActorScope(tx, command);
      await this.lockIssue(tx, command, false);
      const current = await this.lockComment(tx, command);
      this.requireEditable(current, command);
      if (current.version !== command.expectedVersion) commentError('comment_version_conflict', 'Comment has changed; reload before applying this action');
      const now = await this.databaseNow(tx);
      const row = await tx.comment.update({
        where: { id: current.id },
        data: { body: command.body, version: { increment: 1 }, editedAt: now, updatedAt: now },
        include: { author: { select: { displayName: true } } },
      });
      await this.writeActivity(tx, command, row.id, 'comment_edited', row.version);
      await this.writeOutbox(tx, command, row.id, 'issue.comment.updated', row.version);
      return toComment(row);
    }, TX_OPTIONS);
  }

  async deleteAuthorized(command: AuthorizedCommentMutation): Promise<IssueComment> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActorScope(tx, command);
      await this.lockIssue(tx, command, false);
      const current = await this.lockComment(tx, command);
      this.requireEditable(current, command);
      if (current.version !== command.expectedVersion) commentError('comment_version_conflict', 'Comment has changed; reload before applying this action');
      const now = await this.databaseNow(tx);
      const row = await tx.comment.update({
        where: { id: current.id },
        data: { body: null, deletedAt: now, updatedAt: now, version: { increment: 1 } },
        include: { author: { select: { displayName: true } } },
      });
      await this.writeActivity(tx, command, row.id, 'comment_deleted', row.version);
      await this.writeOutbox(tx, command, row.id, 'issue.comment.deleted', row.version);
      return toComment(row);
    }, TX_OPTIONS);
  }

  private async lockActorScope(tx: Tx, scope: CommentScope & { actorUserId: string }): Promise<void> {
    const workspace = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM workspaces WHERE id = ${scope.workspaceId}::uuid FOR KEY SHARE`;
    if (!workspace[0]) notFound();
    const teams = await tx.$queryRaw<LockedTeam[]>`SELECT visibility FROM teams WHERE workspace_id = ${scope.workspaceId}::uuid AND id = ${scope.teamId}::uuid FOR UPDATE`;
    if (!teams[0]) notFound();
    const actor = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT u.id::text AS user_id FROM users u
      JOIN workspace_memberships wm ON wm.user_id = u.id
      WHERE wm.workspace_id = ${scope.workspaceId}::uuid AND wm.user_id = ${scope.actorUserId}::uuid AND u.status = 'active'
      FOR UPDATE OF u, wm`;
    if (!actor[0]) commentError('comment_forbidden', 'You cannot access this team');
    if (teams[0].visibility === 'private') {
      const membership = await tx.$queryRaw<Array<{ user_id: string }>>`
        SELECT user_id::text AS user_id FROM team_memberships
        WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid AND user_id = ${scope.actorUserId}::uuid
        FOR UPDATE`;
      if (!membership[0]) commentError('comment_forbidden', 'You cannot access this team');
    }
  }

  private async lockIssue(tx: Tx, scope: CommentScope, includeArchived: boolean): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string; archived_at: Date | null }>>`
      SELECT id::text AS id, archived_at FROM issues
      WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid AND id = ${scope.issueId}::uuid
      FOR UPDATE`;
    if (!rows[0] || (!includeArchived && rows[0].archived_at)) notFound();
  }

  private async lockComment(tx: Tx, command: AuthorizedCommentMutation): Promise<CommentRow> {
    const ids = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM comments WHERE workspace_id = ${command.workspaceId}::uuid AND team_id = ${command.teamId}::uuid
        AND issue_id = ${command.issueId}::uuid AND id = ${command.commentId}::uuid FOR UPDATE`;
    if (!ids[0]) notFound();
    const row = await tx.comment.findFirst({ where: {
      id: command.commentId, workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId,
    }, include: { author: { select: { displayName: true } } } });
    if (!row) notFound();
    return row;
  }

  private requireEditable(row: CommentRow, command: AuthorizedCommentMutation): void {
    if (row.deletedAt) notFound();
    if (row.authorUserId !== command.actorUserId) commentError('comment_forbidden', 'Only the comment author can change this comment');
  }

  private async databaseNow(tx: Tx): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!rows[0]) throw new Error('Database clock unavailable');
    return rows[0].now;
  }

  private async writeActivity(tx: Tx, command: CommentScope & { actorUserId: string }, commentId: string,
    kind: 'comment_created' | 'comment_edited' | 'comment_deleted', version: number): Promise<void> {
    await tx.issueActivityEvent.create({ data: {
      workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId,
      actorUserId: command.actorUserId, eventKind: kind,
      metadata: { commentId, version } as Prisma.InputJsonValue,
    } });
  }

  private async writeOutbox(tx: Tx, command: CommentScope, commentId: string, kind: string, version: number): Promise<void> {
    const issue = await tx.issue.findFirst({
      where: { workspaceId: command.workspaceId, teamId: command.teamId, id: command.issueId },
      select: { version: true },
    });
    if (!issue) notFound();
    await tx.outboxEvent.create({ data: {
      workspaceId: command.workspaceId, teamId: command.teamId, issueId: command.issueId,
      eventKind: kind,
      payload: { issue_id: command.issueId, version: issue.version, comment_id: commentId, comment_version: version },
    } });
  }
}
