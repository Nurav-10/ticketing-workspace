import { createHash } from 'node:crypto';

export const ISSUE_TITLE_MAX_LENGTH = 250;
export const ISSUE_DESCRIPTION_MAX_LENGTH = 20_000;
export const ISSUE_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const ISSUE_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'done', 'canceled'] as const;
export type IssueStatus = typeof ISSUE_STATUSES[number];
export const ISSUE_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type IssuePriority = typeof ISSUE_PRIORITIES[number];

export interface IssueAssigneeSummary {
  id: string;
  displayName: string;
}

/** Built-in Phase 3 workflow. Phase 4 may replace this with an injected workflow port. */
export const ISSUE_TRANSITIONS: Readonly<Record<IssueStatus, readonly IssueStatus[]>> = {
  backlog: ['todo', 'canceled'],
  todo: ['backlog', 'in_progress', 'canceled'],
  in_progress: ['todo', 'done', 'canceled'],
  done: ['todo'],
  canceled: ['backlog', 'todo'],
};

export interface IssueScope {
  workspaceId: string;
  teamId: string;
}

export interface IssueSummary {
  id: string;
  workspaceId: string;
  teamId: string;
  issueNumber: number;
  /** Current display key only; stable resource identity is `id`. */
  key: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  workflowStatusId?: string | null;
  priority: IssuePriority;
  assigneeUserId: string | null;
  /** Display information only while the assignee has current access to this issue's team. */
  assignee: IssueAssigneeSummary | null;
  createdByUserId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateIssueInput extends IssueScope {
  title: string;
  description?: string | null;
  priority?: IssuePriority;
  assigneeUserId?: string | null;
  idempotencyKey: string;
}

export interface CreateIssueCommand extends IssueScope {
  actorUserId: string;
  title: string;
  description: string | null;
  priority: IssuePriority;
  assigneeUserId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  /** Duration only; persistence calculates expiry from the database clock. */
  idempotencyRetentionMs: number;
}

export interface IssueListQuery extends IssueScope {
  limit?: number;
  cursor?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeUserId?: string;
  archived?: boolean;
}

export interface NormalizedIssueListQuery extends IssueScope {
  limit: number;
  cursor?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeUserId?: string;
  archived?: boolean;
}

export interface IssuePatchInput extends IssueScope {
  issueId: string;
  expectedVersion: number;
  title?: string;
  description?: string | null;
  priority?: IssuePriority;
  assigneeUserId?: string | null;
}

export interface NormalizedIssuePatch extends IssueScope {
  issueId: string;
  expectedVersion: number;
  changes: {
    title?: string;
    description?: string | null;
    priority?: IssuePriority;
    assigneeUserId?: string | null;
  };
}

export interface TransitionIssueInput extends IssueScope {
  issueId: string;
  expectedVersion: number;
  targetStatus: IssueStatus;
}

export interface IssueMutationInput extends IssueScope {
  issueId: string;
  expectedVersion: number;
}

export interface IssueDetailQuery extends IssueScope {
  issueId: string;
  activityLimit?: number;
  activityCursor?: string;
}

export type IssueErrorCode =
  | 'invalid_issue_input'
  | 'issue_not_found'
  | 'issue_forbidden'
  | 'issue_version_conflict'
  | 'issue_invalid_transition'
  | 'issue_number_exhausted'
  | 'issue_idempotency_conflict'
  | 'issue_assignee_unavailable';

/** Stable domain intent; HTTP routes can map this vocabulary to their public envelope. */
export class IssueDomainError extends Error {
  constructor(readonly code: IssueErrorCode, message: string) {
    super(message);
    this.name = 'IssueDomainError';
  }
}

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && (ISSUE_STATUSES as readonly string[]).includes(value);
}

export function isIssuePriority(value: unknown): value is IssuePriority {
  return typeof value === 'string' && (ISSUE_PRIORITIES as readonly string[]).includes(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function assertScope(scope: IssueScope): void {
  if (!scope || !isUuid(scope.workspaceId) || !isUuid(scope.teamId)) invalid('Workspace and team IDs must be UUIDs');
}

function invalid(message: string): never {
  throw new IssueDomainError('invalid_issue_input', message);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function validateTitle(value: unknown): string {
  if (typeof value !== 'string') return invalid('Title is required');
  const title = value.trim();
  const length = codePointLength(title);
  if (title.includes('\0') || length < 1 || length > ISSUE_TITLE_MAX_LENGTH) {
    return invalid(`Title must contain 1 to ${ISSUE_TITLE_MAX_LENGTH} characters and no null characters`);
  }
  return title;
}

function validateDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.includes('\0') || codePointLength(value) > ISSUE_DESCRIPTION_MAX_LENGTH) {
    return invalid(`Description must contain at most ${ISSUE_DESCRIPTION_MAX_LENGTH} characters and no null characters`);
  }
  return value;
}

function validatePriority(value: unknown): IssuePriority {
  if (value === undefined) return 'none';
  if (!isIssuePriority(value)) return invalid('Priority is invalid');
  return value;
}

function validateAssignee(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) return invalid('Assignee ID must be a UUID');
  return value;
}

function validateVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('Expected version must be a positive integer');
  return value as number;
}

function validateKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > ISSUE_IDEMPOTENCY_KEY_MAX_LENGTH
    || !/^[\x21-\x7e]+$/.test(value)) {
    invalid(`Idempotency-Key must contain 1 to ${ISSUE_IDEMPOTENCY_KEY_MAX_LENGTH} visible ASCII characters`);
  }
  return value;
}

/** Normalize user-editable values before hashing or handing them to a repository. */
export function validateCreateIssueInput(input: CreateIssueInput): Omit<CreateIssueCommand, 'actorUserId' | 'payloadHash' | 'idempotencyRetentionMs'> {
  assertScope(input);
  return {
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    title: validateTitle(input.title),
    description: validateDescription(input.description),
    priority: validatePriority(input.priority),
    assigneeUserId: validateAssignee(input.assigneeUserId),
    idempotencyKey: validateKey(input.idempotencyKey),
  };
}

export function createPayloadHash(input: Pick<CreateIssueCommand, 'workspaceId' | 'teamId' | 'title' | 'description' | 'priority' | 'assigneeUserId'>): string {
  // Fixed property order and normalized values make semantically identical retries stable.
  const canonical = JSON.stringify({
    workspaceId: input.workspaceId.toLowerCase(),
    teamId: input.teamId.toLowerCase(),
    title: input.title,
    description: input.description,
    priority: input.priority,
    assigneeUserId: input.assigneeUserId?.toLowerCase() ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function validateListQuery(query: IssueListQuery): NormalizedIssueListQuery {
  assertScope(query);
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Limit must be an integer from 1 to 100');
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length < 1 || query.cursor.length > 512)) {
    invalid('Cursor is invalid');
  }
  if (query.status !== undefined && !isIssueStatus(query.status)) invalid('Status is invalid');
  if (query.priority !== undefined && !isIssuePriority(query.priority)) invalid('Priority is invalid');
  if (query.assigneeUserId !== undefined && !isUuid(query.assigneeUserId)) invalid('Assignee ID must be a UUID');
  if (query.archived !== undefined && typeof query.archived !== 'boolean') invalid('Archived filter is invalid');
  return {
    workspaceId: query.workspaceId,
    teamId: query.teamId,
    limit,
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.priority !== undefined ? { priority: query.priority } : {}),
    ...(query.assigneeUserId !== undefined ? { assigneeUserId: query.assigneeUserId } : {}),
    ...(query.archived !== undefined ? { archived: query.archived } : {}),
  };
}

export function validateIssuePatch(input: IssuePatchInput): NormalizedIssuePatch {
  assertScope(input);
  if (!isUuid(input.issueId)) invalid('Issue ID must be a UUID');
  const changes: NormalizedIssuePatch['changes'] = {};
  if (Object.hasOwn(input, 'title')) changes.title = validateTitle(input.title);
  if (Object.hasOwn(input, 'description')) changes.description = validateDescription(input.description);
  if (Object.hasOwn(input, 'priority')) changes.priority = validatePriority(input.priority);
  if (Object.hasOwn(input, 'assigneeUserId')) changes.assigneeUserId = validateAssignee(input.assigneeUserId);
  if (Object.keys(changes).length === 0) invalid('Patch must change at least one supported field');
  return { workspaceId: input.workspaceId, teamId: input.teamId, issueId: input.issueId, expectedVersion: validateVersion(input.expectedVersion), changes };
}

export function validateTransition(input: TransitionIssueInput): TransitionIssueInput {
  assertScope(input);
  if (!isUuid(input.issueId)) invalid('Issue ID must be a UUID');
  if (!isIssueStatus(input.targetStatus)) invalid('Target status is invalid');
  return { ...input, expectedVersion: validateVersion(input.expectedVersion) };
}

export function validateMutation(input: IssueMutationInput): IssueMutationInput {
  assertScope(input);
  if (!isUuid(input.issueId)) invalid('Issue ID must be a UUID');
  return { ...input, expectedVersion: validateVersion(input.expectedVersion) };
}

export function allowedTransitionSources(target: IssueStatus): readonly IssueStatus[] {
  return ISSUE_STATUSES.filter((source) => ISSUE_TRANSITIONS[source].includes(target));
}

export function canTransition(source: IssueStatus, target: IssueStatus): boolean {
  return ISSUE_TRANSITIONS[source].includes(target);
}
