/**
 * Provider/framework-independent proposed workspace policy.
 *
 * This module is intentionally pure and is not wired into routes or services yet.
 * Callers must supply membership, target, invitation, team, and team-membership facts
 * fetched by trusted application services from PostgreSQL. For target-sensitive
 * mutations, services must fetch/revalidate and lock the target in the same transaction
 * that performs the mutation; this pure decision cannot prevent a time-of-check/time-of-use
 * race by itself. These checks do not authenticate a caller,
 * fetch or filter resources, establish a transaction, or replace tenant-scoped database
 * queries and foreign-key constraints.
 */

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type TeamVisibility = 'workspace' | 'private';

/** A current row fact returned by a trusted membership query, never a request claim. */
export interface WorkspaceMembershipFact {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  isActive: boolean;
}

/** A current team row fact returned by a trusted workspace-scoped team query. */
export interface TeamFact {
  workspaceId: string;
  teamId: string;
  visibility: TeamVisibility;
}

/** A current team-membership row fact; all identifiers must match the request scope. */
export interface TeamMembershipFact {
  workspaceId: string;
  teamId: string;
  userId: string;
}

/** Current invitation state fetched by a trusted, workspace-scoped service query. */
export interface InvitationFact {
  workspaceId: string;
  invitationId: string;
  role: 'admin' | 'member';
  isPending: boolean;
}

export type WorkspaceAction =
  | 'readWorkspace'
  | 'manageWorkspaceSettings'
  | 'inviteAdmin'
  | 'inviteMember'
  | 'listInvitations'
  | 'revokeAdminInvitation'
  | 'revokeMemberInvitation'
  | 'changeMemberRole'
  | 'changeAdminRole'
  | 'removeMember'
  | 'removeAdmin'
  | 'transferOwnership'
  | 'leaveWorkspace';

export type TeamAction = 'readContent' | 'manageMetadata' | 'managePrivateMembership';

export type PolicyDecision =
  | { allowed: true; reason: 'allowed' }
  | { allowed: false; reason: 'not_a_member' | 'team_not_found_in_workspace' | 'team_membership_required' | 'not_a_private_team' | 'forbidden' | 'owner_transfer_required' | 'target_fact_required' | 'target_not_in_workspace' | 'target_type_mismatch' | 'invitation_not_pending' };

export interface WorkspacePolicyFacts {
  requestedWorkspaceId: string;
  actorUserId: string;
  membership: WorkspaceMembershipFact | null;
  /** Required for role/removal/transfer decisions; never accept directly from a request. */
  targetUserId?: string;
  targetMembership?: WorkspaceMembershipFact | null;
  /** Required for invitation revocation; fetched in the same transaction as mutation. */
  targetInvitationId?: string;
  invitation?: InvitationFact | null;
}

export interface TeamPolicyFacts extends WorkspacePolicyFacts {
  requestedTeamId: string;
  team: TeamFact | null;
  teamMembership: TeamMembershipFact | null;
}

const ownerActions: readonly WorkspaceAction[] = [
  'readWorkspace',
  'manageWorkspaceSettings',
  'inviteAdmin',
  'inviteMember',
  'listInvitations',
  'revokeAdminInvitation',
  'revokeMemberInvitation',
  'changeMemberRole',
  'changeAdminRole',
  'removeMember',
  'removeAdmin',
  'transferOwnership',
  'leaveWorkspace',
];

const adminActions: readonly WorkspaceAction[] = [
  'readWorkspace',
  'manageWorkspaceSettings',
  'inviteMember',
  'listInvitations',
  'revokeMemberInvitation',
  'removeMember',
  'leaveWorkspace',
];

const memberActions: readonly WorkspaceAction[] = ['readWorkspace', 'leaveWorkspace'];

const permissions: Record<WorkspaceRole, readonly WorkspaceAction[]> = {
  owner: ownerActions,
  admin: adminActions,
  member: memberActions,
};

function allow(): PolicyDecision {
  return { allowed: true, reason: 'allowed' };
}

function deny(reason: Exclude<PolicyDecision, { allowed: true }>['reason']): PolicyDecision {
  return { allowed: false, reason };
}

function hasMatchingActiveMembership(facts: WorkspacePolicyFacts): facts is WorkspacePolicyFacts & {
  membership: WorkspaceMembershipFact;
} {
  return facts.membership !== null
    && facts.membership.isActive
    && facts.membership.workspaceId === facts.requestedWorkspaceId
    && facts.membership.userId === facts.actorUserId;
}

/**
 * Decide a workspace action using trusted, already-fetched facts. Target-sensitive
 * actions fail closed without matching target facts; the mutation service must fetch
 * and revalidate/lock those rows inside its own transaction.
 */
export function decideWorkspaceAction(facts: WorkspacePolicyFacts, action: WorkspaceAction): PolicyDecision {
  if (!hasMatchingActiveMembership(facts)) return deny('not_a_member');

  if (action === 'leaveWorkspace' && facts.membership.role === 'owner') {
    // The service may re-check after an ownership transfer inside the same transaction.
    return deny('owner_transfer_required');
  }

  if (!permissions[facts.membership.role].includes(action)) return deny('forbidden');

  if (action === 'changeMemberRole' || action === 'removeMember') {
    return hasTargetMembership(facts, 'member');
  }
  if (action === 'changeAdminRole' || action === 'removeAdmin') {
    return hasTargetMembership(facts, 'admin');
  }
  if (action === 'transferOwnership') {
    const target = facts.targetMembership;
    if (!target || !facts.targetUserId) return deny('target_fact_required');
    if (target.workspaceId !== facts.requestedWorkspaceId || target.userId !== facts.targetUserId || !target.isActive) {
      return deny('target_not_in_workspace');
    }
    if (target.userId === facts.actorUserId) return deny('target_type_mismatch');
  }
  if (action === 'revokeMemberInvitation' || action === 'revokeAdminInvitation') {
    const invitation = facts.invitation;
    if (!invitation || !facts.targetInvitationId) return deny('target_fact_required');
    if (invitation.workspaceId !== facts.requestedWorkspaceId || invitation.invitationId !== facts.targetInvitationId) {
      return deny('target_not_in_workspace');
    }
    const expectedRole = action === 'revokeAdminInvitation' ? 'admin' : 'member';
    if (invitation.role !== expectedRole) return deny('target_type_mismatch');
    if (!invitation.isPending) return deny('invitation_not_pending');
  }
  return allow();
}

function hasTargetMembership(facts: WorkspacePolicyFacts, expectedRole: WorkspaceRole): PolicyDecision {
  const target = facts.targetMembership;
  if (!target || !facts.targetUserId) return deny('target_fact_required');
  if (target.workspaceId !== facts.requestedWorkspaceId || target.userId !== facts.targetUserId || !target.isActive) {
    return deny('target_not_in_workspace');
  }
  if (target.role !== expectedRole || target.userId === facts.actorUserId) return deny('target_type_mismatch');
  return allow();
}

/**
 * Decide team-content or team-administration access from trusted scoped facts.
 * Workspace owners/admins have no implicit bypass for private team content.
 */
export function decideTeamAction(facts: TeamPolicyFacts, action: TeamAction): PolicyDecision {
  if (!hasMatchingActiveMembership(facts)) return deny('not_a_member');

  const { team, membership } = facts;
  if (!team
    || team.workspaceId !== facts.requestedWorkspaceId
    || team.teamId !== facts.requestedTeamId) {
    return deny('team_not_found_in_workspace');
  }

  if (action === 'readContent') {
    if (team.visibility === 'workspace') return allow();

    const hasMatchingTeamMembership = facts.teamMembership !== null
      && facts.teamMembership.workspaceId === facts.requestedWorkspaceId
      && facts.teamMembership.teamId === facts.requestedTeamId
      && facts.teamMembership.userId === facts.actorUserId;
    return hasMatchingTeamMembership ? allow() : deny('team_membership_required');
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') return deny('forbidden');

  if (action === 'managePrivateMembership' && team.visibility !== 'private') {
    return deny('not_a_private_team');
  }

  if (action === 'managePrivateMembership') {
    const target = facts.targetMembership;
    if (!target || !facts.targetUserId) return deny('target_fact_required');
    if (target.workspaceId !== facts.requestedWorkspaceId
      || target.userId !== facts.targetUserId
      || !target.isActive) {
      return deny('target_not_in_workspace');
    }
  }

  // Existing team visibility is immutable in the proposed Phase 1 policy. Metadata
  // management therefore covers ordinary team metadata, not visibility changes.
  return allow();
}
