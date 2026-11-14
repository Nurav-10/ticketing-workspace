export interface RedeemInvitationResult { workspaceId: string; role: 'admin' | 'member'; }
export type InvitationRole = 'admin' | 'member';

export interface IssuedInvitationRecord {
  id: string;
  email: string;
  role: InvitationRole;
  expiresAt: Date;
}

export interface InvitationRepository {
  issue(input: { workspaceId: string; actorUserId: string; email: string; role: InvitationRole; tokenHash: Buffer }): Promise<IssuedInvitationRecord>;
  revoke(input: { workspaceId: string; actorUserId: string; invitationId: string }): Promise<void>;
  redeem(input: { userId: string; tokenHash: Buffer }): Promise<RedeemInvitationResult>;
}
