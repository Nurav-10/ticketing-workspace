import type { Principal } from '../auth/authenticator.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  WorkflowDomainError,
  assertScope,
  isUuid,
  validateAddTransitionInput,
  validateCreateStatusInput,
  validateDeleteTransitionInput,
  validateRetireStatusInput,
  validateUpdateStatusInput,
  type AddTransitionInput,
  type CreateStatusInput,
  type DeleteTransitionInput,
  type RetireStatusInput,
  type UpdateStatusInput,
  type WorkflowConfiguration,
  type WorkflowScope,
  type WorkflowStatusSummary,
  type WorkflowTransitionSummary,
} from './workflow-domain.js';
import type { WorkflowRepository } from './workflow-repository.js';

export interface WorkflowService {
  getWorkflowForPrincipal(principal: Principal, scope: WorkflowScope): Promise<WorkflowConfiguration>;
  listStatusesForPrincipal(principal: Principal, scope: WorkflowScope, includeRetired?: boolean): Promise<WorkflowStatusSummary[]>;
  getStatusForPrincipal(principal: Principal, scope: WorkflowScope, statusId: string): Promise<WorkflowStatusSummary>;
  createStatusForPrincipal(principal: Principal, input: CreateStatusInput): Promise<{ status: WorkflowStatusSummary; version: number }>;
  updateStatusForPrincipal(principal: Principal, input: UpdateStatusInput): Promise<{ status: WorkflowStatusSummary; version: number }>;
  retireStatusForPrincipal(principal: Principal, input: RetireStatusInput): Promise<{ retiredStatusId: string; reassignedCount: number; version: number }>;
  addTransitionForPrincipal(principal: Principal, input: AddTransitionInput): Promise<{ transition: WorkflowTransitionSummary; version: number }>;
  deleteTransitionForPrincipal(principal: Principal, input: DeleteTransitionInput): Promise<{ version: number }>;
}

function actorId(principal: Principal): string {
  if (!principal || !isUuid(principal.userId)) {
    throw new WorkflowDomainError('workflow_forbidden', 'A verified principal is required');
  }
  return principal.userId;
}

export class WorkflowApplicationService implements WorkflowService {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly prisma: PrismaClient,
  ) {}

  async getWorkflowForPrincipal(principal: Principal, scope: WorkflowScope): Promise<WorkflowConfiguration> {
    assertScope(scope);
    const actor = actorId(principal);
    await this.requireTeamReadAccess(scope, actor);
    return this.repository.getWorkflow(scope);
  }

  async listStatusesForPrincipal(principal: Principal, scope: WorkflowScope, includeRetired = false): Promise<WorkflowStatusSummary[]> {
    assertScope(scope);
    const actor = actorId(principal);
    await this.requireTeamReadAccess(scope, actor);
    return this.repository.listStatuses(scope, includeRetired);
  }

  async getStatusForPrincipal(principal: Principal, scope: WorkflowScope, statusId: string): Promise<WorkflowStatusSummary> {
    assertScope(scope);
    if (!isUuid(statusId)) {
      throw new WorkflowDomainError('invalid_workflow_input', 'Status ID must be a UUID');
    }
    const actor = actorId(principal);
    await this.requireTeamReadAccess(scope, actor);
    const status = await this.repository.getStatus(scope, statusId);
    if (!status) {
      throw new WorkflowDomainError('workflow_not_found', 'Status not found');
    }
    return status;
  }

  async createStatusForPrincipal(principal: Principal, input: CreateStatusInput): Promise<{ status: WorkflowStatusSummary; version: number }> {
    const actor = actorId(principal);
    const validated = validateCreateStatusInput(input);
    await this.requireTeamAdminAccess(input, actor);
    return this.repository.createStatus({ ...validated, actorUserId: actor });
  }

  async updateStatusForPrincipal(principal: Principal, input: UpdateStatusInput): Promise<{ status: WorkflowStatusSummary; version: number }> {
    const actor = actorId(principal);
    const validated = validateUpdateStatusInput(input);
    await this.requireTeamAdminAccess(input, actor);
    return this.repository.updateStatus({ ...validated, actorUserId: actor });
  }

  async retireStatusForPrincipal(principal: Principal, input: RetireStatusInput): Promise<{ retiredStatusId: string; reassignedCount: number; version: number }> {
    const actor = actorId(principal);
    const validated = validateRetireStatusInput(input);
    await this.requireTeamAdminAccess(input, actor);
    return this.repository.retireStatus({ ...validated, actorUserId: actor });
  }

  async addTransitionForPrincipal(principal: Principal, input: AddTransitionInput): Promise<{ transition: WorkflowTransitionSummary; version: number }> {
    const actor = actorId(principal);
    const validated = validateAddTransitionInput(input);
    await this.requireTeamAdminAccess(input, actor);
    return this.repository.addTransition({ ...validated, actorUserId: actor });
  }

  async deleteTransitionForPrincipal(principal: Principal, input: DeleteTransitionInput): Promise<{ version: number }> {
    const actor = actorId(principal);
    const validated = validateDeleteTransitionInput(input);
    await this.requireTeamAdminAccess(input, actor);
    return this.repository.deleteTransition({ ...validated, actorUserId: actor });
  }

  private async requireTeamReadAccess(scope: WorkflowScope, actorUserId: string): Promise<void> {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        userId: actorUserId,
        user: { status: 'active' },
      },
      select: { role: true },
    });
    if (!membership) {
      throw new WorkflowDomainError('workflow_not_found', 'Workspace or team not found');
    }

    const team = await this.prisma.team.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        id: scope.teamId,
      },
      select: { visibility: true },
    });
    if (!team) {
      throw new WorkflowDomainError('workflow_not_found', 'Workspace or team not found');
    }

    if (team.visibility === 'private') {
      const teamMembership = await this.prisma.teamMembership.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          teamId: scope.teamId,
          userId: actorUserId,
        },
        select: { userId: true },
      });
      if (!teamMembership) {
        throw new WorkflowDomainError('workflow_not_found', 'Workspace or team not found');
      }
    }
  }

  private async requireTeamAdminAccess(scope: WorkflowScope, actorUserId: string): Promise<void> {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        userId: actorUserId,
        user: { status: 'active' },
      },
      select: { role: true },
    });
    if (!membership) {
      throw new WorkflowDomainError('workflow_not_found', 'Workspace or team not found');
    }

    const team = await this.prisma.team.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        id: scope.teamId,
      },
      select: { visibility: true },
    });
    if (!team) {
      throw new WorkflowDomainError('workflow_not_found', 'Workspace or team not found');
    }

    if (team.visibility === 'private') {
      const teamMembership = await this.prisma.teamMembership.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          teamId: scope.teamId,
          userId: actorUserId,
        },
        select: { userId: true },
      });
      if (!teamMembership) {
        throw new WorkflowDomainError('workflow_not_found', 'Workspace or team not found');
      }
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new WorkflowDomainError('workflow_forbidden', 'Only team administrators can modify workflows');
    }
  }
}
