import type { Principal } from '../auth/authenticator.js';
import { isUuid } from '../issues/issue-domain.js';
import type { IssueLabelAssignmentResult, IssueLabelRepository, ReplaceIssueLabelsCommand } from './issue-label-repository.js';

export const ISSUE_LABEL_MAX_COUNT = 50;

export type IssueLabelErrorCode =
  | 'invalid_issue_label_input'
  | 'issue_label_not_found'
  | 'issue_label_forbidden'
  | 'issue_label_version_conflict';

export class IssueLabelDomainError extends Error {
  constructor(readonly code: IssueLabelErrorCode, message: string) {
    super(message);
    this.name = 'IssueLabelDomainError';
  }
}

export interface ReplaceIssueLabelsInput {
  workspaceId: string;
  teamId: string;
  issueId: string;
  expectedVersion: number;
  labelIds: readonly string[];
}

function invalid(message: string): never {
  throw new IssueLabelDomainError('invalid_issue_label_input', message);
}

function uuid(value: unknown, label: string): string {
  if (!isUuid(value)) return invalid(`${label} must be a UUID`);
  return value.toLowerCase();
}

function actorId(principal: Principal): string {
  if (!principal || !isUuid(principal.userId) || typeof principal.sessionId !== 'string' || principal.sessionId.length === 0) {
    throw new IssueLabelDomainError('issue_label_forbidden', 'A verified principal is required');
  }
  return principal.userId.toLowerCase();
}

function strictObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Issue-label input must be an object');
  const allowed = ['workspaceId', 'teamId', 'issueId', 'expectedVersion', 'labelIds'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('Issue-label input contains an unsupported field');
}

function command(input: ReplaceIssueLabelsInput, actorUserId: string): ReplaceIssueLabelsCommand {
  strictObject(input);
  if (!Array.isArray(input.labelIds) || input.labelIds.length > ISSUE_LABEL_MAX_COUNT) {
    return invalid(`At most ${ISSUE_LABEL_MAX_COUNT} labels may be assigned to an issue`);
  }
  const labelIds = input.labelIds.map((id) => uuid(id, 'Label ID'));
  if (new Set(labelIds).size !== labelIds.length) return invalid('Label IDs cannot contain duplicates');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) return invalid('Expected issue version must be a positive integer');
  return {
    workspaceId: uuid(input.workspaceId, 'Workspace ID'),
    teamId: uuid(input.teamId, 'Team ID'),
    issueId: uuid(input.issueId, 'Issue ID'),
    actorUserId,
    expectedVersion: input.expectedVersion,
    labelIds: labelIds.sort(),
  };
}

/** Principal validation and bounded replacement validation for issue-label assignments. */
export class IssueLabelApplicationService {
  constructor(private readonly repository: IssueLabelRepository) {}

  async getForPrincipal(principal: Principal, input: { workspaceId: string; teamId: string; issueId: string }): Promise<IssueLabelAssignmentResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['workspaceId', 'teamId', 'issueId'].includes(key))) invalid('Issue-label input contains an unsupported field');
    return this.repository.getAuthorized({
      workspaceId: uuid(input.workspaceId, 'Workspace ID'), teamId: uuid(input.teamId, 'Team ID'),
      issueId: uuid(input.issueId, 'Issue ID'), actorUserId: actorId(principal),
    });
  }

  async replaceForPrincipal(principal: Principal, input: ReplaceIssueLabelsInput): Promise<IssueLabelAssignmentResult> {
    return this.repository.replaceAuthorized(command(input, actorId(principal)));
  }
}
