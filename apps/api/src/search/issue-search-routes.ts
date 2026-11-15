import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import { isUuid } from '../issues/issue-domain.js';
import { IssueSearchDomainError } from './issue-search-domain.js';
import type { IssueSearchApplicationService } from './issue-search-service.js';

const SEARCH_ROOT = '/workspaces/:workspaceId/teams/:teamId/issues/search';

function invalidRequest(): ApiError {
  return new ApiError(400, 'invalid_request', 'Request validation failed');
}

function requirePrincipal(request: Request) {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}

function requireUuid(value: unknown): string {
  if (!isUuid(value)) throw invalidRequest();
  return value;
}

function strictBody(request: Request): Record<string, unknown> {
  const value: unknown = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['searchTerm', 'archiveMode', 'limit', 'cursor'].includes(key))
    || typeof body.searchTerm !== 'string'
    || (body.archiveMode !== undefined && !['active', 'archived', 'all'].includes(body.archiveMode as string))
    || (body.limit !== undefined && typeof body.limit !== 'number')
    || (body.cursor !== undefined && typeof body.cursor !== 'string')) throw invalidRequest();
  return body;
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof IssueSearchDomainError) {
      const status = error.code === 'issue_search_not_found' ? 404
        : error.code === 'issue_search_cursor_stale' ? 409 : 400;
      const code = error.code === 'issue_search_not_found' ? 'not_found'
        : error.code === 'issue_search_cursor_stale' ? 'stale_cursor' : 'invalid_request';
      throw new ApiError(status, code, error.message);
    }
    throw error;
  }
}

/** POST keeps query text out of URLs. */
export function registerIssueSearchRoutes(router: Router, service: IssueSearchApplicationService): void {
  router.use(SEARCH_ROOT, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post(SEARCH_ROOT, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    if (Object.keys(request.query).length) throw invalidRequest();
    const body = strictBody(request);
    const result = await invoke(() => service.searchForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId),
      searchTerm: body.searchTerm as string,
      ...(body.archiveMode !== undefined ? { archiveMode: body.archiveMode as 'active' | 'archived' | 'all' } : {}),
      ...(body.limit !== undefined ? { limit: body.limit as number } : {}),
      ...(body.cursor !== undefined ? { cursor: body.cursor as string } : {}),
    }));
    response.json({ data: result });
  });
}
