export type AssignableWorkspaceRole = 'admin' | 'member';

export interface MembershipMutationInput {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}

export interface ChangeMembershipRoleInput extends MembershipMutationInput {
  role: AssignableWorkspaceRole;
}

export interface LeaveWorkspaceInput {
  workspaceId: string;
  actorUserId: string;
  /** Required only when the actor is the current owner. Transfer and departure are atomic. */
  transferToUserId?: string;
}

export interface MembershipRepository {
  changeRole(input: ChangeMembershipRoleInput): Promise<void>;
  removeMember(input: MembershipMutationInput): Promise<void>;
  transferOwnership(input: MembershipMutationInput): Promise<void>;
  leaveWorkspace(input: LeaveWorkspaceInput): Promise<void>;
}
