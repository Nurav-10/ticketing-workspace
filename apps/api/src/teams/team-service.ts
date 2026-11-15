import type { Principal } from '../auth/authenticator.js';
import type { CreateTeamInput, PrivateTeamListInput, PrivateTeamMembershipInput, PrivateTeamRosterInput, TeamManagementPage, TeamMemberManagementRecord, TeamRepository, TeamSummary } from './team-repository.js';

export interface TeamLister {
  listVisibleToPrincipal(principal: Principal, workspaceId: string): Promise<TeamSummary[]>;
}

export interface TeamAdministrator {
  createForPrincipal(principal: Principal, input: Omit<CreateTeamInput, 'actorUserId'>): Promise<TeamSummary>;
  addPrivateMemberForPrincipal(principal: Principal, input: Omit<PrivateTeamMembershipInput, 'actorUserId'>): Promise<void>;
  removePrivateMemberForPrincipal(principal: Principal, input: Omit<PrivateTeamMembershipInput, 'actorUserId'>): Promise<void>;
  listPrivateMembersForPrincipal(principal: Principal, input: Omit<PrivateTeamRosterInput, 'actorUserId'>): Promise<TeamManagementPage<TeamMemberManagementRecord>>;
  listPrivateTeamsForPrincipal(principal: Principal, input: Omit<PrivateTeamListInput, 'actorUserId'>): Promise<TeamManagementPage<TeamSummary>>;
}

export class TeamService implements TeamLister, TeamAdministrator {
  constructor(private readonly repository: TeamRepository) {}

  listVisibleToPrincipal(principal: Principal, workspaceId: string): Promise<TeamSummary[]> {
    return this.repository.listVisibleToUser(workspaceId, principal.userId);
  }

  createForPrincipal(principal: Principal, input: Omit<CreateTeamInput, 'actorUserId'>): Promise<TeamSummary> {
    return this.repository.createForAdministrator({ ...input, actorUserId: principal.userId });
  }

  addPrivateMemberForPrincipal(principal: Principal, input: Omit<PrivateTeamMembershipInput, 'actorUserId'>): Promise<void> {
    return this.repository.addPrivateMember({ ...input, actorUserId: principal.userId });
  }

  removePrivateMemberForPrincipal(principal: Principal, input: Omit<PrivateTeamMembershipInput, 'actorUserId'>): Promise<void> {
    return this.repository.removePrivateMember({ ...input, actorUserId: principal.userId });
  }

  listPrivateMembersForPrincipal(principal: Principal, input: Omit<PrivateTeamRosterInput, 'actorUserId'>): Promise<TeamManagementPage<TeamMemberManagementRecord>> {
    return this.repository.listPrivateMembersForAdministrator({ ...input, actorUserId: principal.userId });
  }

  listPrivateTeamsForPrincipal(principal: Principal, input: Omit<PrivateTeamListInput, 'actorUserId'>): Promise<TeamManagementPage<TeamSummary>> {
    return this.repository.listPrivateTeamsForAdministrator({ ...input, actorUserId: principal.userId });
  }
}
