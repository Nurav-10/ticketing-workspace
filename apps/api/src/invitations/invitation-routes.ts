import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/api-error.js';
import type { InvitationAdministrator } from './invitation-service.js';

const redeemBody = z.object({ token: z.string().min(40).max(100) }).strict();
const issueBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(['admin', 'member'])
}).strict();
const listLimit = z.number().int().min(1).max(100);
const listEmail = z.string().trim().toLowerCase().email().max(320);
const findByEmailBody = z.object({ email: listEmail }).strict();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ApiError(400, 'invalid_request', 'Request validation failed');
  return value;
}

export function registerInvitationRoutes(app: Router, service: InvitationAdministrator): void {
  app.get('/workspaces/:workspaceId/invitations', async (request: Request, response: Response) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    response.setHeader('Cache-Control', 'no-store');
    const workspaceId = requireUuid(request.params.workspaceId);
    const rawLimit = request.query.limit;
    const rawEmail = request.query.email;
    let limit = 50;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
        throw new ApiError(400, 'invalid_request', 'Request validation failed');
      }
      const parsed = listLimit.safeParse(Number(rawLimit));
      if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request validation failed');
      limit = parsed.data;
    }
    if (rawEmail !== undefined) throw new ApiError(400, 'invalid_request', 'Request validation failed');
    response.json({ data: await service.listPending(request.principal, workspaceId, limit) });
  });

  app.post('/workspaces/:workspaceId/invitations/search', async (request: Request, response: Response) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    response.setHeader('Cache-Control', 'no-store');
    const workspaceId = requireUuid(request.params.workspaceId);
    const parsed = findByEmailBody.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request validation failed');
    response.json({ data: await service.listPending(request.principal, workspaceId, 1, parsed.data.email) });
  });

  app.post('/workspaces/:workspaceId/invitations', async (request: Request, response: Response) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    response.setHeader('Cache-Control', 'no-store');
    const workspaceId = requireUuid(request.params.workspaceId);
    const parsed = issueBody.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request validation failed');
    const invitation = await service.issue(request.principal, workspaceId, parsed.data);
    response.status(201).json({ data: invitation });
  });

  app.delete('/workspaces/:workspaceId/invitations/:invitationId', async (request: Request, response: Response) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    const workspaceId = requireUuid(request.params.workspaceId);
    const invitationId = requireUuid(request.params.invitationId);
    await service.revoke(request.principal, workspaceId, invitationId);
    response.status(204).end();
  });

  app.post('/invitations/redeem', async (request: Request, response: Response) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    const parsed = redeemBody.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request validation failed');
    response.json({ data: await service.redeem(request.principal, parsed.data.token) });
  });
}
