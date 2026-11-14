import type { FastifyInstance } from 'fastify';
import { ApiError } from '../shared/api-error.js';
import type { WorkspaceLister } from './workspace-service.js';

export function registerWorkspaceRoutes(app: FastifyInstance, service: WorkspaceLister): void {
  app.get('/api/v1/workspaces', async (request) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    return { data: await service.listForPrincipal(request.principal) };
  });
}
