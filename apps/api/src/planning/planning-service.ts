import type { Principal } from '../auth/authenticator.js';
import { ApiError } from '../shared/api-error.js';
import type { CycleInput, GroupIssueInput, PlanningRepository, ProjectInput } from './planning-types.js';

export interface PlanningService {
  listProjects(principal: Principal, scope: { workspaceId: string; teamId: string }): Promise<unknown[]>;
  createProject(principal: Principal, input: Omit<ProjectInput, 'actorUserId'>): Promise<unknown>;
  listCycles(principal: Principal, scope: { workspaceId: string; teamId: string }): Promise<unknown[]>;
  createCycle(principal: Principal, input: Omit<CycleInput, 'actorUserId'>): Promise<unknown>;
  groupIssue(principal: Principal, input: Omit<GroupIssueInput, 'actorUserId'>): Promise<unknown>;
}

export class PlanningApplicationService implements PlanningService {
  constructor(private readonly repository: PlanningRepository) {}

  private actor(principal: Principal): string {
    if (!principal?.userId) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    return principal.userId;
  }

  async listProjects(principal: Principal, scope: { workspaceId: string; teamId: string }) {
    return this.repository.listProjects({ ...scope, actorUserId: this.actor(principal) });
  }
  async createProject(principal: Principal, input: Omit<ProjectInput, 'actorUserId'>) {
    if (input.startAt && input.targetAt && input.startAt > input.targetAt) {
      throw new ApiError(400, 'invalid_project_dates', 'Project target must not precede its start');
    }
    return this.repository.createProject({ ...input, actorUserId: this.actor(principal) });
  }
  async listCycles(principal: Principal, scope: { workspaceId: string; teamId: string }) {
    return this.repository.listCycles({ ...scope, actorUserId: this.actor(principal) });
  }
  async createCycle(principal: Principal, input: Omit<CycleInput, 'actorUserId'>) {
    if (!(input.startAt instanceof Date) || !(input.endAt instanceof Date) || input.startAt >= input.endAt) {
      throw new ApiError(400, 'invalid_cycle_dates', 'Cycle end must be after its start');
    }
    return this.repository.createCycle({ ...input, actorUserId: this.actor(principal) });
  }
  async groupIssue(principal: Principal, input: Omit<GroupIssueInput, 'actorUserId'>) {
    return this.repository.groupIssue({ ...input, actorUserId: this.actor(principal) });
  }
}
