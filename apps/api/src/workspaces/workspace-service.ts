import type { Principal } from '../auth/authenticator.js';
import type { WorkspaceRepository, WorkspaceSummary } from './workspace-repository.js';

export interface WorkspaceLister {
  listForPrincipal(principal: Principal): Promise<WorkspaceSummary[]>;
}

export class WorkspaceService implements WorkspaceLister {
  constructor(private readonly repository: WorkspaceRepository) {}

  listForPrincipal(principal: Principal): Promise<WorkspaceSummary[]> {
    return this.repository.listForUser(principal.userId);
  }
}
