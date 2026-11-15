import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import type { TeamAdministrator, TeamLister } from './team-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ApiError(400, 'invalid_request', 'Request validation failed');
  return value;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function pageOptions(request: Request): { limit: number; cursor?: string } {
  const limitValue = request.query.limit;
  let limit = DEFAULT_PAGE_SIZE;
  if (limitValue !== undefined) {
    if (typeof limitValue !== 'string' || !/^[1-9][0-9]*$/.test(limitValue)) {
      throw new ApiError(400, 'invalid_request', 'Request validation failed');
    }
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_SIZE) throw new ApiError(400, 'invalid_request', 'Request validation failed');
  }
  const cursorValue = request.query.cursor;
  if (cursorValue === undefined) return { limit };
  return { limit, cursor: requireUuid(cursorValue as string | string[] | undefined) };
}

function requirePrincipal(request: Request) {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}

function strictObjectBody(request: Request, fields: string[]): Record<string, unknown> {
  const value: unknown = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_request', 'Request validation failed');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !fields.includes(key)) || fields.some((key) => !(key in body))) {
    throw new ApiError(400, 'invalid_request', 'Request validation failed');
  }
  return body;
}

export function registerTeamRoutes(app: Router, service: TeamLister & TeamAdministrator): void {
  app.get('/workspaces/:workspaceId/teams', async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    response.json({ data: await service.listVisibleToPrincipal(principal, workspaceId) });
  });

  app.post('/workspaces/:workspaceId/teams', async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const body = strictObjectBody(request, ['name', 'key', 'visibility']);
    if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.trim().length > 120 ||
        typeof body.key !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/.test(body.key) ||
        (body.visibility !== 'workspace' && body.visibility !== 'private')) {
      throw new ApiError(400, 'invalid_request', 'Request validation failed');
    }
    const team = await service.createForPrincipal(principal, {
      workspaceId, name: body.name.trim(), key: body.key, visibility: body.visibility
    });
    response.status(201).json({ data: team });
  });

  app.post('/workspaces/:workspaceId/teams/:teamId/members/:userId', async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    await service.addPrivateMemberForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId),
      teamId: requireUuid(request.params.teamId),
      targetUserId: requireUuid(request.params.userId)
    });
    response.status(204).end();
  });

  app.get('/workspaces/:workspaceId/private-teams', async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const page = await service.listPrivateTeamsForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId),
      ...pageOptions(request)
    });
    response.set('Cache-Control', 'no-store');
    response.json({ data: page.data, pageInfo: { hasMore: page.hasMore, nextCursor: page.nextCursor } });
  });

  app.get('/workspaces/:workspaceId/teams/:teamId/members', async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const page = await service.listPrivateMembersForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId),
      teamId: requireUuid(request.params.teamId),
      ...pageOptions(request)
    });
    response.set('Cache-Control', 'no-store');
    response.json({ data: page.data, pageInfo: { hasMore: page.hasMore, nextCursor: page.nextCursor } });
  });

  app.delete('/workspaces/:workspaceId/teams/:teamId/members/:userId', async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    await service.removePrivateMemberForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId),
      teamId: requireUuid(request.params.teamId),
      targetUserId: requireUuid(request.params.userId)
    });
    response.status(204).end();
  });
}
