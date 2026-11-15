import type {
  NormalizedCreateStatusCommand,
  NormalizedRetireStatusCommand,
  NormalizedUpdateStatusCommand,
  WorkflowConfiguration,
  WorkflowScope,
  WorkflowStatusSummary,
  WorkflowTransitionSummary,
} from './workflow-domain.js';

export interface AddTransitionCommand extends WorkflowScope {
  actorUserId: string;
  sourceStatusId: string;
  targetStatusId: string;
  expectedVersion: number;
}

export interface DeleteTransitionCommand extends WorkflowScope {
  actorUserId: string;
  sourceStatusId: string;
  targetStatusId: string;
  expectedVersion: number;
}

export interface WorkflowRepository {
  /**
   * Retrieves the canonical workflow configuration for a team, including all
   * active and retired statuses in position order, transition edges, and the
   * current workflow configuration version.
   */
  getWorkflow(scope: WorkflowScope): Promise<WorkflowConfiguration>;

  /**
   * Lists statuses for a team in display order.
   */
  listStatuses(scope: WorkflowScope, includeRetired?: boolean): Promise<WorkflowStatusSummary[]>;

  /**
   * Resolves a status by UUID within team scope.
   */
  getStatus(scope: WorkflowScope, statusId: string): Promise<WorkflowStatusSummary | null>;

  /**
   * Resolves a status by key within team scope.
   */
  getStatusByKey(scope: WorkflowScope, key: string): Promise<WorkflowStatusSummary | null>;

  /**
   * Creates a new status inside an authorized transaction.
   * Locks workspace -> team -> checks expectedVersion -> checks key uniqueness ->
   * assigns position -> commits status and increments team workflowVersion.
   */
  createStatus(command: NormalizedCreateStatusCommand): Promise<{ status: WorkflowStatusSummary; version: number }>;

  /**
   * Updates an existing status (name, category, position, isDefault).
   * Verifies expectedVersion, checks retired state, handles position shifts,
   * updates status, and increments team workflowVersion.
   */
  updateStatus(command: NormalizedUpdateStatusCommand): Promise<{ status: WorkflowStatusSummary; version: number }>;

  /**
   * Retires a status with atomic issue reassignment.
   * Validates targetStatus exists in the same team and is not retired.
   * Atomically reassigns all issues referencing the status to targetStatus,
   * removes associated transition edges, marks status retired, and increments
   * team workflowVersion.
   */
  retireStatus(command: NormalizedRetireStatusCommand): Promise<{ retiredStatusId: string; reassignedCount: number; version: number }>;

  /**
   * Adds a transition edge between two active statuses in the team.
   */
  addTransition(command: AddTransitionCommand): Promise<{ transition: WorkflowTransitionSummary; version: number }>;

  /**
   * Deletes a transition edge.
   */
  deleteTransition(command: DeleteTransitionCommand): Promise<{ version: number }>;
}
