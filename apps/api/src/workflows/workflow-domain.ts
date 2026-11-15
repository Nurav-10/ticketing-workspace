export const WORKFLOW_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
export type WorkflowStatusCategory = typeof WORKFLOW_CATEGORIES[number];

export const WORKFLOW_STATUS_KEY_MAX_LENGTH = 64;
export const WORKFLOW_STATUS_NAME_MAX_LENGTH = 100;

export interface WorkflowScope {
  workspaceId: string;
  teamId: string;
}

export interface WorkflowStatusSummary {
  id: string;
  workspaceId: string;
  teamId: string;
  key: string;
  name: string;
  category: WorkflowStatusCategory;
  position: number;
  isDefault: boolean;
  isRetired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowTransitionSummary {
  id: string;
  workspaceId: string;
  teamId: string;
  sourceStatusId: string;
  targetStatusId: string;
  createdAt: Date;
}

export interface WorkflowConfiguration {
  version: number;
  statuses: WorkflowStatusSummary[];
  transitions: WorkflowTransitionSummary[];
}

export interface CreateStatusInput extends WorkflowScope {
  key: string;
  name: string;
  category: WorkflowStatusCategory;
  position?: number | undefined;
  isDefault?: boolean | undefined;
  expectedVersion: number;
}

export interface NormalizedCreateStatusCommand extends WorkflowScope {
  actorUserId: string;
  key: string;
  name: string;
  category: WorkflowStatusCategory;
  position?: number | undefined;
  isDefault: boolean;
  expectedVersion: number;
}

export interface UpdateStatusInput extends WorkflowScope {
  statusId: string;
  name?: string | undefined;
  category?: WorkflowStatusCategory | undefined;
  position?: number | undefined;
  isDefault?: boolean | undefined;
  expectedVersion: number;
}

export interface NormalizedUpdateStatusCommand extends WorkflowScope {
  actorUserId: string;
  statusId: string;
  expectedVersion: number;
  changes: {
    name?: string | undefined;
    category?: WorkflowStatusCategory | undefined;
    position?: number | undefined;
    isDefault?: boolean | undefined;
  };
}

export interface RetireStatusInput extends WorkflowScope {
  statusId: string;
  targetStatusId: string;
  expectedVersion: number;
}

export interface NormalizedRetireStatusCommand extends WorkflowScope {
  actorUserId: string;
  statusId: string;
  targetStatusId: string;
  expectedVersion: number;
}

export interface AddTransitionInput extends WorkflowScope {
  sourceStatusId: string;
  targetStatusId: string;
  expectedVersion: number;
}

export interface DeleteTransitionInput extends WorkflowScope {
  sourceStatusId: string;
  targetStatusId: string;
  expectedVersion: number;
}

export type WorkflowErrorCode =
  | 'invalid_workflow_input'
  | 'workflow_not_found'
  | 'workflow_forbidden'
  | 'workflow_version_conflict'
  | 'workflow_key_exists'
  | 'workflow_position_conflict'
  | 'workflow_invalid_transition'
  | 'workflow_status_retired'
  | 'workflow_default_invariant_violated'
  | 'workflow_reassignment_target_invalid';

export class WorkflowDomainError extends Error {
  constructor(readonly code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowDomainError';
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isWorkflowCategory(value: unknown): value is WorkflowStatusCategory {
  return typeof value === 'string' && (WORKFLOW_CATEGORIES as readonly string[]).includes(value);
}

export function assertScope(scope: WorkflowScope): void {
  if (!scope || !isUuid(scope.workspaceId) || !isUuid(scope.teamId)) {
    throw new WorkflowDomainError('invalid_workflow_input', 'Workspace and team IDs must be UUIDs');
  }
}

function invalid(message: string): never {
  throw new WorkflowDomainError('invalid_workflow_input', message);
}

function codePointLength(value: string): number {
  return [...value].length;
}

export function validateKey(value: unknown): string {
  if (typeof value !== 'string') return invalid('Status key is required');
  const key = value.trim().toLowerCase();
  if (key.length < 1 || key.length > WORKFLOW_STATUS_KEY_MAX_LENGTH || !/^[a-z0-9_-]{1,64}$/.test(key)) {
    return invalid(`Status key must contain 1 to ${WORKFLOW_STATUS_KEY_MAX_LENGTH} lowercase alphanumeric characters, hyphens or underscores`);
  }
  return key;
}

export function validateName(value: unknown): string {
  if (typeof value !== 'string') return invalid('Status name is required');
  const name = value.trim();
  const length = codePointLength(name);
  if (length < 1 || length > WORKFLOW_STATUS_NAME_MAX_LENGTH) {
    return invalid(`Status name must contain 1 to ${WORKFLOW_STATUS_NAME_MAX_LENGTH} characters`);
  }
  return name;
}

export function validateCategory(value: unknown): WorkflowStatusCategory {
  if (!isWorkflowCategory(value)) return invalid('Status category is invalid');
  return value;
}

export function validatePosition(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('Position must be a non-negative integer');
  }
  return value as number;
}

export function validateExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return invalid('Expected version must be a positive integer');
  }
  return value as number;
}

export function validateCreateStatusInput(input: CreateStatusInput): Omit<NormalizedCreateStatusCommand, 'actorUserId'> {
  assertScope(input);
  const key = validateKey(input.key);
  const name = validateName(input.name);
  const category = validateCategory(input.category);
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  const position = input.position !== undefined ? validatePosition(input.position) : undefined;
  const isDefault = input.isDefault === true;

  return {
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    key,
    name,
    category,
    ...(position !== undefined ? { position } : {}),
    isDefault,
    expectedVersion,
  };
}

export function validateUpdateStatusInput(input: UpdateStatusInput): Omit<NormalizedUpdateStatusCommand, 'actorUserId'> {
  assertScope(input);
  if (!isUuid(input.statusId)) invalid('Status ID must be a UUID');
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  const changes: NormalizedUpdateStatusCommand['changes'] = {};

  if (Object.hasOwn(input, 'name')) changes.name = validateName(input.name);
  if (Object.hasOwn(input, 'category')) changes.category = validateCategory(input.category);
  if (Object.hasOwn(input, 'position')) changes.position = validatePosition(input.position);
  if (Object.hasOwn(input, 'isDefault')) {
    if (typeof input.isDefault !== 'boolean') invalid('isDefault must be a boolean');
    changes.isDefault = input.isDefault;
  }

  if (Object.keys(changes).length === 0) invalid('Update must modify at least one status property');

  return {
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    statusId: input.statusId,
    expectedVersion,
    changes,
  };
}

export function validateRetireStatusInput(input: RetireStatusInput): Omit<NormalizedRetireStatusCommand, 'actorUserId'> {
  assertScope(input);
  if (!isUuid(input.statusId)) invalid('Status ID must be a UUID');
  if (!isUuid(input.targetStatusId)) invalid('Target reassignment status ID must be a UUID');
  if (input.statusId === input.targetStatusId) {
    throw new WorkflowDomainError('workflow_reassignment_target_invalid', 'Cannot reassign issues to the status being retired');
  }
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  return {
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    statusId: input.statusId,
    targetStatusId: input.targetStatusId,
    expectedVersion,
  };
}

export function validateAddTransitionInput(input: AddTransitionInput): AddTransitionInput {
  assertScope(input);
  if (!isUuid(input.sourceStatusId)) invalid('Source status ID must be a UUID');
  if (!isUuid(input.targetStatusId)) invalid('Target status ID must be a UUID');
  if (input.sourceStatusId === input.targetStatusId) {
    throw new WorkflowDomainError('workflow_invalid_transition', 'Transition edge cannot connect a status to itself');
  }
  return {
    ...input,
    expectedVersion: validateExpectedVersion(input.expectedVersion),
  };
}

export function validateDeleteTransitionInput(input: DeleteTransitionInput): DeleteTransitionInput {
  assertScope(input);
  if (!isUuid(input.sourceStatusId)) invalid('Source status ID must be a UUID');
  if (!isUuid(input.targetStatusId)) invalid('Target status ID must be a UUID');
  return {
    ...input,
    expectedVersion: validateExpectedVersion(input.expectedVersion),
  };
}
