import type {
  CreateIssueCommand,
  IssueMutationInput,
  IssueScope,
  IssueSummary,
  NormalizedIssueListQuery,
  NormalizedIssuePatch,
  IssueStatus,
} from './issue-domain.js';

export interface IssueActorScope extends IssueScope {
  actorUserId: string;
}

export interface AuthorizedIssueListQuery extends IssueActorScope, Omit<NormalizedIssueListQuery, keyof IssueScope> {}
export interface AuthorizedIssueMutation extends IssueActorScope, IssueMutationInput {}
export interface AuthorizedIssuePatch extends IssueActorScope, NormalizedIssuePatch {}

export type IssueActivityKind =
  | 'created'
  | 'fields_changed'
  | 'status_changed'
  | 'archived'
  | 'restored'
  | 'comment_created'
  | 'comment_edited'
  | 'comment_deleted'
  | 'project_changed'
  | 'cycle_changed';

/** Allowlisted history metadata. Issue title/description and arbitrary request data do not belong here. */
export interface IssueActivityMetadata {
  changedFields?: readonly ('title' | 'description' | 'priority' | 'assigneeUserId' | 'projectId' | 'cycleId')[];
  statusBefore?: IssueStatus;
  statusAfter?: IssueStatus;
  priorityBefore?: string;
  priorityAfter?: string;
  assigneeBefore?: string | null;
  assigneeAfter?: string | null;
  commentId?: string;
  version?: number;
  projectBefore?: string | null;
  projectAfter?: string | null;
  cycleBefore?: string | null;
  cycleAfter?: string | null;
}

export interface IssueActivityRecord {
  id: string;
  issueId: string;
  actorUserId: string;
  /** Current display information is omitted when the actor no longer has team access. */
  actor: { id: string; displayName: string } | null;
  kind: IssueActivityKind;
  metadata: IssueActivityMetadata;
  createdAt: Date;
}

export interface IssuePage {
  items: IssueSummary[];
  /** Opaque, stable continuation cursor; absent when the page is complete. */
  nextCursor?: string;
}

export interface IssueDetail {
  issue: IssueSummary;
  activity: IssueActivityRecord[];
  nextActivityCursor?: string;
}

export interface IssueRepository {
  /**
   * In one DB transaction: lock/authorize workspace, team and actor membership in the
   * documented global order; validate assignee membership; allocate the team number;
   * and commit issue, activity, outbox and actor/workspace/operation idempotency result.
   * Same key/hash returns its canonical prior issue; a different hash throws
   * `issue_idempotency_conflict`. Expiry is calculated using the database clock.
   * After expiry, the key can be reused only after locking and replacing the expired
   * record in the same transaction; a concurrent reuse has exactly one winner.
   * No issue is read by UUID outside the supplied scope, including replay.
   */
  createAuthorized(command: CreateIssueCommand): Promise<IssueSummary>;

  /** Query must be tenant-scoped and visibility-filtered in the repository query itself. */
  listAuthorized(query: AuthorizedIssueListQuery): Promise<IssuePage>;

  /** Resolve issue and membership/team facts under both workspace and team predicates. */
  getAuthorized(input: IssueActorScope & { issueId: string; activityLimit?: number; activityCursor?: string }): Promise<IssueDetail>;

  /**
   * Recheck actor/team access and assignee eligibility inside the write transaction.
   * Update with workspace/team/id/version predicates; increment version and write one
   * activity and one outbox row atomically. A zero-row compare-and-swap is reported as
   * `issue_version_conflict` only after scoped current-state resolution.
   */
  updateAuthorized(input: AuthorizedIssuePatch): Promise<IssueSummary>;

  /**
   * Recheck access, lock scoped issue, enforce current status in allowedFromStatuses
   * and expectedVersion, then write status/version/activity/outbox atomically.
   */
  transitionAuthorized(input: AuthorizedIssueMutation & {
    targetStatus: IssueStatus;
    allowedFromStatuses: readonly IssueStatus[];
  }): Promise<IssueSummary>;

  /**
   * Soft archive or restore with scoped expected-version compare-and-swap. Each is a
   * single transaction with one activity and one outbox row. Restore requires archived;
   * archive requires live. Both increment version; no hard delete exists in this port.
   */
  setArchivedAuthorized(input: AuthorizedIssueMutation & { archived: boolean }): Promise<IssueSummary>;
}
