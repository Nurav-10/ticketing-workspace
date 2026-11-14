import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import type { WorkspaceMembershipAdministrator } from './membership-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ApiError(400, 'invalid_request', 'Request validation failed');
  return value;
}

function principal(request: Request) {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}

function body(request: Request, allowedKeys: string[], requiredKeys: string[] = []): Record<string, unknown> {
  const value: unknown = request.body;
  if (value === undefined && requiredKeys.length === 0) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_request', 'Request validation failed');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !(key in record))) {
    throw new ApiError(400, 'invalid_request', 'Request validation failed');
  }
  return record;
}

export function registerMembershipRoutes(app: Router, service: WorkspaceMembershipAdministrator): void {
  app.patch('/workspaces/:workspaceId/members/:userId', async (request: Request, response: Response) => {
    const data = body(request, ['role'], ['role']);
    if (data.role !== 'admin' && data.role !== 'member') throw new ApiError(400, 'invalid_request', 'Request validation failed');
    await service.changeRoleForPrincipal(principal(request), {
      workspaceId: uuid(request.params.workspaceId),
      targetUserId: uuid(request.params.userId),
      role: data.role
    });
    response.status(204).end();
  });

  app.delete('/workspaces/:workspaceId/members/:userId', async (request: Request, response: Response) => {
    await service.removeMemberForPrincipal(principal(request), {
      workspaceId: uuid(request.params.workspaceId),
      targetUserId: uuid(request.params.userId)
    });
    response.status(204).end();
  });

  app.post('/workspaces/:workspaceId/ownership/transfer', async (request: Request, response: Response) => {
    const data = body(request, ['targetUserId'], ['targetUserId']);
    if (typeof data.targetUserId !== 'string') throw new ApiError(400, 'invalid_request', 'Request validation failed');
    await service.transferOwnershipForPrincipal(principal(request), {
      workspaceId: uuid(request.params.workspaceId),
      targetUserId: uuid(data.targetUserId)
    });
    response.status(204).end();
  });

  app.delete('/workspaces/:workspaceId/membership', async (request: Request, response: Response) => {
    const data = body(request, ['transferToUserId']);
    let transferToUserId: string | undefined;
    if (data.transferToUserId !== undefined) {
      if (typeof data.transferToUserId !== 'string') throw new ApiError(400, 'invalid_request', 'Request validation failed');
      transferToUserId = uuid(data.transferToUserId);
    }
    await service.leaveWorkspaceForPrincipal(principal(request), {
      workspaceId: uuid(request.params.workspaceId),
      ...(transferToUserId ? { transferToUserId } : {})
    });
    response.status(204).end();
  });
}
