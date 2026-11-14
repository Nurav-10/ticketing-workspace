import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import type { WorkspaceLister } from './workspace-service.js';

export function registerWorkspaceRoutes(app: Router, service: WorkspaceLister): void {
  app.get('/workspaces', async (request: Request, response: Response) => {
    if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    response.json({ data: await service.listForPrincipal(request.principal) });
  });
}
