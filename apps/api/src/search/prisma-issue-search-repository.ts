import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { isUuid, type IssueSummary } from '../issues/issue-domain.js';
import { IssueSearchDomainError } from './issue-search-domain.js';
import type { AuthorizedIssueSearch, IssueSearchItem, IssueSearchPage, IssueSearchRepository } from './issue-search-service.js';

interface CursorPayload { version: 1; rank: number; id: string; binding: string; generation: string; }
interface SearchRow {
  authorized: boolean;
  generation: string | null;
  id: string | null;
  workspaceId: string | null;
  teamId: string | null;
  issueNumber: number | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
  version: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  archivedAt: Date | null;
  teamKey: string | null;
  rank: number | null;
}
interface RankedSummary { item: IssueSearchItem; rank: number; }

function invalidCursor(): never {
  throw new IssueSearchDomainError('invalid_issue_search_input', 'Search cursor is invalid for this request');
}

function isGeneration(value: unknown): value is string {
  // PostgreSQL BIGINT has at most 19 decimal digits; preserve it as text to
  // avoid precision loss in JavaScript.
  return typeof value === 'string' && value.length <= 19 && /^[1-9]\d*$/.test(value);
}

function summary(row: SearchRow): IssueSearchItem {
  if (row.id === null || row.workspaceId === null || row.teamId === null || row.issueNumber === null
    || row.title === null || row.status === null || row.priority === null || row.createdByUserId === null
    || row.version === null || row.createdAt === null || row.updatedAt === null || row.teamKey === null) {
    throw new Error('Search result row was incomplete');
  }
  return {
    id: row.id, workspaceId: row.workspaceId, teamId: row.teamId, issueNumber: row.issueNumber,
    key: `${row.teamKey}-${row.issueNumber}`, title: row.title,
    status: row.status as IssueSummary['status'], priority: row.priority as IssueSummary['priority'],
    assigneeUserId: row.assigneeUserId, createdByUserId: row.createdByUserId, version: row.version,
    createdAt: row.createdAt, updatedAt: row.updatedAt, archivedAt: row.archivedAt,
  };
}

/** PostgreSQL FTS adapter. Search terms are bound parameters and are never logged or returned. */
export class PrismaIssueSearchRepository implements IssueSearchRepository {
  private readonly secret: Buffer;

  constructor(private readonly prisma: PrismaClient, cursorSecret: string) {
    this.secret = Buffer.from(cursorSecret, 'utf8');
    if (this.secret.byteLength < 32) throw new Error('Issue search cursor secret must be at least 32 bytes');
  }

  async searchAuthorized(query: AuthorizedIssueSearch): Promise<IssueSearchPage> {
    const binding = this.binding(query);
    const cursor = query.cursor ? this.decodeCursor(query.cursor, binding) : undefined;
    const rows = await this.prisma.$transaction(async (tx) => tx.$queryRaw<SearchRow[]>(Prisma.sql`
      WITH authorized_team AS MATERIALIZED (
        SELECT t.issue_query_version::text AS generation
        FROM teams AS t
        JOIN workspace_memberships AS wm
          ON wm.workspace_id = t.workspace_id AND wm.user_id = ${query.actorUserId}::uuid
        JOIN users AS u ON u.id = wm.user_id AND u.status = 'active'
        WHERE t.workspace_id = ${query.workspaceId}::uuid AND t.id = ${query.teamId}::uuid
          AND (
            t.visibility = 'workspace'
            OR (t.visibility = 'private' AND EXISTS (
              SELECT 1 FROM team_memberships AS tm
              WHERE tm.workspace_id = t.workspace_id AND tm.team_id = t.id AND tm.user_id = wm.user_id
            ))
          )
      ),
      authorized_scope AS MATERIALIZED (
        SELECT EXISTS (SELECT 1 FROM authorized_team) AS authorized
      ),
      authorized_issues AS MATERIALIZED (
        SELECT i.id, i.workspace_id, i.team_id, i.issue_number, i.title,
          i.status, i.priority, i.assignee_user_id, i.created_by_user_id, i.version,
          i.created_at, i.updated_at, i.archived_at, i.search_vector, t.key AS team_key
        FROM issues AS i
        JOIN teams AS t ON t.workspace_id = i.workspace_id AND t.id = i.team_id
        CROSS JOIN authorized_scope AS scope
        CROSS JOIN authorized_team AS team_scope
        WHERE scope.authorized
          AND i.workspace_id = ${query.workspaceId}::uuid AND i.team_id = ${query.teamId}::uuid
          AND (${query.archiveMode !== 'archived'}::boolean OR i.archived_at IS NOT NULL)
          AND (${query.archiveMode !== 'active'}::boolean OR i.archived_at IS NULL)
          AND i.search_vector @@ plainto_tsquery('pg_catalog.simple'::regconfig, ${query.searchTerm})
      ),
      ranked AS MATERIALIZED (
        SELECT authorized_issues.*,
          ts_rank_cd(authorized_issues.search_vector, plainto_tsquery('pg_catalog.simple'::regconfig, ${query.searchTerm}))::real AS rank
        FROM authorized_issues
      ),
      page AS MATERIALIZED (
        SELECT * FROM ranked
        WHERE NOT ${cursor !== undefined}::boolean
          OR rank < ${cursor?.rank ?? 0}::real
          OR (rank = ${cursor?.rank ?? 0}::real AND id > ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        ORDER BY rank DESC, id ASC
        LIMIT ${query.limit + 1}
      )
      SELECT scope.authorized, team_scope.generation,
        page.id::text AS id, page.workspace_id::text AS "workspaceId", page.team_id::text AS "teamId",
        page.issue_number AS "issueNumber", page.title,
        page.status::text AS status, page.priority::text AS priority,
        page.assignee_user_id::text AS "assigneeUserId", page.created_by_user_id::text AS "createdByUserId",
        page.version, page.created_at AS "createdAt", page.updated_at AS "updatedAt", page.archived_at AS "archivedAt",
        page.team_key AS "teamKey", page.rank
      FROM authorized_scope AS scope
      LEFT JOIN authorized_team AS team_scope ON true
      LEFT JOIN page ON true
      ORDER BY page.rank DESC NULLS LAST, page.id ASC NULLS LAST`), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 10_000,
    });

    if (!rows[0]?.authorized) {
      throw new IssueSearchDomainError('issue_search_not_found', 'Search results are unavailable');
    }
    const generation = rows[0].generation;
    if (!isGeneration(generation)) throw new Error('Issue query generation was unavailable');
    if (cursor && cursor.generation !== generation) {
      throw new IssueSearchDomainError('issue_search_cursor_stale', 'Search results changed; restart from the first page');
    }
    const ranked = rows.filter((row): row is SearchRow & { id: string; rank: number } => row.id !== null && row.rank !== null)
      .map((row): RankedSummary => ({ item: summary(row), rank: row.rank }));
    const hasMore = ranked.length > query.limit;
    const page = ranked.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(({ item }) => item),
      ...(hasMore && last ? { nextCursor: this.encodeCursor({ version: 1, rank: last.rank, id: last.item.id, binding, generation }) } : {}),
    };
  }

  private binding(query: AuthorizedIssueSearch): string {
    return createHash('sha256').update(JSON.stringify({
      workspaceId: query.workspaceId, teamId: query.teamId, actorUserId: query.actorUserId,
      searchTerm: query.searchTerm, archiveMode: query.archiveMode, limit: query.limit,
    })).digest('base64url');
  }

  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private decodeCursor(value: string, binding: string): CursorPayload {
    if (value.length > 1_024) return invalidCursor();
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match) return invalidCursor();
    const [, encoded, signature] = match;
    const expected = createHmac('sha256', this.secret).update(encoded!).digest();
    const supplied = Buffer.from(signature!, 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) return invalidCursor();
    let valueObject: unknown;
    try { valueObject = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')); }
    catch { return invalidCursor(); }
    if (!valueObject || typeof valueObject !== 'object' || Array.isArray(valueObject)) return invalidCursor();
    const payload = valueObject as Partial<CursorPayload>;
    const keys = Object.keys(valueObject).sort();
    if (keys.join(',') !== 'binding,generation,id,rank,version' || payload.version !== 1 || payload.binding !== binding
      || typeof payload.rank !== 'number' || !Number.isFinite(payload.rank) || payload.rank < 0
      || !isUuid(payload.id) || !isGeneration(payload.generation)) return invalidCursor();
    return payload as CursorPayload;
  }
}
