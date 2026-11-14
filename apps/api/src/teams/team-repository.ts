export interface TeamSummary {
  id: string;
  name: string;
  key: string;
  visibility: 'workspace' | 'private';
}

export interface TeamRepository {
  listVisibleToUser(workspaceId: string, userId: string): Promise<TeamSummary[]>;
  // The current schema has no audit-event model. These mutations therefore do not
  // yet persist audit events; add that storage and same-transaction writes in its
  // dedicated schema slice before advertising team-administration audit coverage.
  createForAdministrator(input: CreateTeamInput): Promise<TeamSummary>;
  addPrivateMember(input: PrivateTeamMembershipInput): Promise<void>;
  removePrivateMember(input: PrivateTeamMembershipInput): Promise<void>;
}

export interface CreateTeamInput {
  workspaceId: string;
  actorUserId: string;
  name: string;
  key: string;
  visibility: 'workspace' | 'private';
}

export interface PrivateTeamMembershipInput {
  workspaceId: string;
  actorUserId: string;
  teamId: string;
  targetUserId: string;
}
