import type { WorkflowStatusSummary } from './workflow-domain.js';

export interface WorkflowPort {
  /**
   * Resolves the canonical default status for a team.
   */
  getDefaultStatus(scope: { workspaceId: string; teamId: string }): Promise<WorkflowStatusSummary>;

  /**
   * Resolves a status by UUID or key within team scope.
   */
  resolveStatus(scope: { workspaceId: string; teamId: string }, statusIdOrKey: string): Promise<WorkflowStatusSummary | null>;

  /**
   * Checks whether a transition between two status IDs is allowed by the configured transition edges.
   */
  canTransition(scope: { workspaceId: string; teamId: string }, sourceStatusId: string, targetStatusId: string): Promise<boolean>;

  /**
   * Lists all active statuses (or optionally including retired) for a team in display order.
   */
  listStatuses(scope: { workspaceId: string; teamId: string }, includeRetired?: boolean): Promise<WorkflowStatusSummary[]>;
}
