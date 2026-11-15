import type { Request, Response, Router } from 'express';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { Principal } from '../auth/authenticator.js';
import { ApiError } from '../shared/api-error.js';

const ROUTE = '/workspaces/:workspaceId/teams/:teamId/assignee-options';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export interface IssueAssigneeOption {
  id: string;
  displayName: string;
}

export interface IssueAssigneePage {
  items: IssueAssigneeOption[];
  nextCursor?: string;
}

export interface IssueAssigneeQuery {
  workspaceId: string;
  teamId: string;
  limit?: number;
  cursor?: string;
}

export interface IssueAssigneeRepository {
  listAuthorized(query: IssueAssigneeQuery & { actorUserId: string }): Promise<IssueAssigneePage>;
}

export interface IssueAssigneeService {
  listForPrincipal(principal: Principal, query: IssueAssigneeQuery): Promise<IssueAssigneePage>;
}

export class IssueAssigneeApplicationService implements IssueAssigneeService {
  constructor(private readonly repository: IssueAssigneeRepository) {}

  listForPrincipal(principal: Principal, query: IssueAssigneeQuery): Promise<IssueAssigneePage> {
    if (!principal || !isUuid(principal.userId)) throw notFound();
    if (!isUuid(query.workspaceId) || !isUuid(query.teamId)) throw invalidRequest();
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalidRequest();
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length < 1 || query.cursor.length > 1024)) throw invalidRequest();
    return this.repository.listAuthorized({ ...query, limit, actorUserId: principal.userId });
  }
}

interface Cursor { id: string; }

/**
 * Tenant-scoped assignee lookup. Both team visibility and actor access are checked
 * before returning options; private-team membership never grants access to an
 * otherwise inactive or non-member caller.
 */
export class PrismaIssueAssigneeRepository implements IssueAssigneeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAuthorized(query: IssueAssigneeQuery & { actorUserId: string }): Promise<IssueAssigneePage> {
    const cursor = decodeCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_LIMIT;
    return this.prisma.$transaction(async (tx) => {
      const actorAccess: Prisma.TeamWhereInput = {
        id: query.teamId,
        workspaceId: query.workspaceId,
        workspace: { memberships: { some: { userId: query.actorUserId, user: { status: 'active' } } } },
        OR: [
          { visibility: 'workspace' },
          { visibility: 'private', memberships: { some: { workspaceId: query.workspaceId, userId: query.actorUserId } } },
        ],
      };
      const authorized = await tx.team.findFirst({ where: actorAccess, select: { id: true } });
      if (!authorized) throw notFound();

      // Keep authorization in this candidate query too. The repeatable-read
      // transaction keeps the preceding 404 check and this page on one snapshot.
      const candidateScope: Prisma.WorkspaceMembershipWhereInput = {
        workspaceId: query.workspaceId,
        user: { status: 'active' },
        AND: [
          { workspace: { teams: { some: actorAccess } } },
          { OR: [
            { workspace: { teams: { some: { id: query.teamId, workspaceId: query.workspaceId, visibility: 'workspace' } } } },
            { teams: { some: { teamId: query.teamId, team: { workspaceId: query.workspaceId, visibility: 'private' } } } },
          ] },
          ...(cursor ? [{ userId: { gt: cursor.id } }] : []),
        ],
      };
      const rows = await tx.workspaceMembership.findMany({
        where: candidateScope,
        orderBy: { userId: 'asc' },
        take: limit + 1,
        select: { userId: true, user: { select: { displayName: true } } },
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).map(({ userId, user }) => ({ id: userId, displayName: user.displayName }));
      const last = page.at(-1);
      return { items: page, ...(hasMore && last ? { nextCursor: encodeCursor({ id: last.id }) } : {}) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}

export function registerIssueAssigneeRoutes(router: Router, service: IssueAssigneeService): void {
  router.get(ROUTE, async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    const principal = requirePrincipal(request);
    if (Object.keys(request.query).some((key) => !['limit', 'cursor'].includes(key))) throw invalidRequest();
    const limitText = singleQuery(request, 'limit');
    const limit = limitText === undefined ? undefined : parseLimit(limitText);
    if (limitText !== undefined && limit === undefined) throw invalidRequest();
    const cursor = singleQuery(request, 'cursor');
    const page = await service.listForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId),
      teamId: requireUuid(request.params.teamId),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    response.json({ data: page });
  });
}

function requirePrincipal(request: Request): Principal {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID_PATTERN.test(value); }
function requireUuid(value: unknown): string { if (!isUuid(value)) throw invalidRequest(); return value; }
function parseLimit(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LIMIT ? parsed : undefined;
}
function singleQuery(request: Request, name: string): string | undefined {
  const value = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidRequest();
  return value;
}
function invalidRequest(): ApiError { return new ApiError(400, 'invalid_request', 'Request validation failed'); }
function notFound(): ApiError { return new ApiError(404, 'not_found', 'Team not found'); }
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Partial<Cursor>;
    if (!isUuid(cursor.id) || Object.keys(cursor).some((key) => key !== 'id')) throw new Error();
    return { id: cursor.id };
  } catch {
    throw invalidRequest();
  }
}
