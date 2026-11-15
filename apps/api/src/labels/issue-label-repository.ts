export interface IssueLabelReadCommand {
  workspaceId: string;
  teamId: string;
  issueId: string;
  actorUserId: string;
}

export interface ReplaceIssueLabelsCommand extends IssueLabelReadCommand {
  expectedVersion: number;
  labelIds: readonly string[];
}

export interface IssueLabelAssignmentResult {
  workspaceId: string;
  teamId: string;
  issueId: string;
  version: number;
  labelIds: string[];
}

export interface IssueLabelRepository {
  getAuthorized(command: IssueLabelReadCommand): Promise<IssueLabelAssignmentResult>;
  /**
   * Atomically replace an issue's scoped labels, increment its expected version,
   * and append compatible activity/outbox records when the set changes. A
   * no-op keeps the version and emits no records.
   */
  replaceAuthorized(command: ReplaceIssueLabelsCommand): Promise<IssueLabelAssignmentResult>;
}
