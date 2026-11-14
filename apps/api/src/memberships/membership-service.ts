import type { Principal } from '../auth/authenticator.js';
import type { AssignableWorkspaceRole, MembershipMutationInput, MembershipRepository } from './membership-repository.js';

export interface WorkspaceMembershipAdministrator {
  changeRoleForPrincipal(principal: Principal, input: Omit<MembershipMutationInput, 'actorUserId'> & { role: AssignableWorkspaceRole }): Promise<void>;
  removeMemberForPrincipal(principal: Principal, input: Omit<MembershipMutationInput, 'actorUserId'>): Promise<void>;
  transferOwnershipForPrincipal(principal: Principal, input: Omit<MembershipMutationInput, 'actorUserId'>): Promise<void>;
  leaveWorkspaceForPrincipal(principal: Principal, input: { workspaceId: string; transferToUserId?: string }): Promise<void>;
}

export class WorkspaceMembershipService implements WorkspaceMembershipAdministrator {
  constructor(private readonly repository: MembershipRepository) {}

  changeRoleForPrincipal(principal: Principal, input: Omit<MembershipMutationInput, 'actorUserId'> & { role: AssignableWorkspaceRole }): Promise<void> {
    return this.repository.changeRole({ ...input, actorUserId: principal.userId });
  }

  removeMemberForPrincipal(principal: Principal, input: Omit<MembershipMutationInput, 'actorUserId'>): Promise<void> {
    return this.repository.removeMember({ ...input, actorUserId: principal.userId });
  }

  transferOwnershipForPrincipal(principal: Principal, input: Omit<MembershipMutationInput, 'actorUserId'>): Promise<void> {
    return this.repository.transferOwnership({ ...input, actorUserId: principal.userId });
  }

  leaveWorkspaceForPrincipal(principal: Principal, input: { workspaceId: string; transferToUserId?: string }): Promise<void> {
    return this.repository.leaveWorkspace({ ...input, actorUserId: principal.userId });
  }
}
