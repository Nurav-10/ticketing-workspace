import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../shared/api-error.js';
import type { InvitationRedeemer } from './invitation-service.js';

const redeemBody = z.object({ token: z.string().min(40).max(100) }).strict();

export function registerInvitationRoutes(app: FastifyInstance, service: InvitationRedeemer): void {
  app.post('/api/v1/invitations/redeem', async (request) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    const parsed = redeemBody.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request validation failed');
    return { data: await service.redeem(request.principal, parsed.data.token) };
  });
}
