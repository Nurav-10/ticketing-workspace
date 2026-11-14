import type { Principal } from '../auth/authenticator.js';
import {
  ISSUE_IDEMPOTENCY_RETENTION_MS,
  IssueDomainError,
  allowedTransitionSources,
  createPayloadHash,
  isUuid,
  validateCreateIssueInput,
  validateIssuePatch,
  validateListQuery,
  validateMutation,
  validateTransition,
  type CreateIssueInput,
  type IssueDetailQuery,
  type IssueListQuery,
  type IssueMutationInput,
  type IssuePatchInput,
  type IssueSummary,
  type TransitionIssueInput,
} from './issue-domain.js';
import type { IssueDetail, IssuePage, IssueRepository } from './issue-repository.js';

/** Public use-case contract. Actor identity always comes from the authenticated principal. */
export interface IssueService {
  createForPrincipal(principal: Principal, input: CreateIssueInput): Promise<IssueSummary>;
  listForPrincipal(principal: Principal, query: IssueListQuery): Promise<IssuePage>;
  getForPrincipal(principal: Principal, input: IssueDetailQuery): Promise<IssueDetail>;
  updateForPrincipal(principal: Principal, input: IssuePatchInput): Promise<IssueSummary>;
  transitionForPrincipal(principal: Principal, input: TransitionIssueInput): Promise<IssueSummary>;
  archiveForPrincipal(principal: Principal, input: IssueMutationInput): Promise<IssueSummary>;
  restoreForPrincipal(principal: Principal, input: IssueMutationInput): Promise<IssueSummary>;
}

function actorId(principal: Principal): string {
  if (!principal || !isUuid(principal.userId)) {
    throw new IssueDomainError('issue_forbidden', 'A verified principal is required');
  }
  return principal.userId;
}

export class IssueApplicationService implements IssueService {
  constructor(private readonly repository: IssueRepository) {}

  createForPrincipal(principal: Principal, input: CreateIssueInput): Promise<IssueSummary> {
    const actorUserId = actorId(principal);
    const normalized = validateCreateIssueInput(input);
    return this.repository.createAuthorized({
      ...normalized,
      actorUserId,
      payloadHash: createPayloadHash(normalized),
      idempotencyRetentionMs: ISSUE_IDEMPOTENCY_RETENTION_MS,
    });
  }

  listForPrincipal(principal: Principal, query: IssueListQuery): Promise<IssuePage> {
    const actorUserId = actorId(principal);
    return this.repository.listAuthorized({ ...validateListQuery(query), actorUserId });
  }

  getForPrincipal(
    principal: Principal,
    input: IssueDetailQuery,
  ): Promise<IssueDetail> {
    const actorUserId = actorId(principal);
    const query = validateListQuery({ workspaceId: input.workspaceId, teamId: input.teamId });
    if (!isUuid(input.issueId)) throw new IssueDomainError('invalid_issue_input', 'Issue ID must be a UUID');
    if (input.activityLimit !== undefined
      && (!Number.isSafeInteger(input.activityLimit) || input.activityLimit < 1 || input.activityLimit > 100)) {
      throw new IssueDomainError('invalid_issue_input', 'Activity limit must be an integer from 1 to 100');
    }
    if (input.activityCursor !== undefined
      && (typeof input.activityCursor !== 'string' || input.activityCursor.length < 1 || input.activityCursor.length > 512)) {
      throw new IssueDomainError('invalid_issue_input', 'Activity cursor is invalid');
    }
    return this.repository.getAuthorized({
      workspaceId: query.workspaceId,
      teamId: query.teamId,
      actorUserId,
      issueId: input.issueId,
      ...(input.activityLimit !== undefined ? { activityLimit: input.activityLimit } : {}),
      ...(input.activityCursor !== undefined ? { activityCursor: input.activityCursor } : {}),
    });
  }

  updateForPrincipal(principal: Principal, input: IssuePatchInput): Promise<IssueSummary> {
    const actorUserId = actorId(principal);
    return this.repository.updateAuthorized({ ...validateIssuePatch(input), actorUserId });
  }

  transitionForPrincipal(principal: Principal, input: TransitionIssueInput): Promise<IssueSummary> {
    const actorUserId = actorId(principal);
    const command = validateTransition(input);
    return this.repository.transitionAuthorized({
      workspaceId: command.workspaceId,
      teamId: command.teamId,
      issueId: command.issueId,
      expectedVersion: command.expectedVersion,
      actorUserId,
      targetStatus: command.targetStatus,
      allowedFromStatuses: allowedTransitionSources(command.targetStatus),
    });
  }

  archiveForPrincipal(principal: Principal, input: IssueMutationInput): Promise<IssueSummary> {
    const actorUserId = actorId(principal);
    return this.repository.setArchivedAuthorized({ ...validateMutation(input), actorUserId, archived: true });
  }

  restoreForPrincipal(principal: Principal, input: IssueMutationInput): Promise<IssueSummary> {
    const actorUserId = actorId(principal);
    return this.repository.setArchivedAuthorized({ ...validateMutation(input), actorUserId, archived: false });
  }
}
