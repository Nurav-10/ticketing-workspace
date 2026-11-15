export interface TeamSummary {
  id: string;
  name: string;
  key: string;
  visibility: 'workspace' | 'private';
}

export interface TeamMemberManagementRecord {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isTeamMember: boolean;
}

export interface TeamManagementPage<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface TeamRepository {
  listVisibleToUser(workspaceId: string, userId: string): Promise<TeamSummary[]>;
  listPrivateMembersForAdministrator(input: PrivateTeamRosterInput): Promise<TeamManagementPage<TeamMemberManagementRecord>>;
  listPrivateTeamsForAdministrator(input: PrivateTeamListInput): Promise<TeamManagementPage<TeamSummary>>;
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

export interface PrivateTeamRosterInput {
  workspaceId: string;
  actorUserId: string;
  teamId: string;
  limit: number;
  cursor?: string;
}

export interface PrivateTeamListInput {
  workspaceId: string;
  actorUserId: string;
  limit: number;
  cursor?: string;
}
