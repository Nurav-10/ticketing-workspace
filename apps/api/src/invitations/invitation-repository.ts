export interface RedeemInvitationResult { workspaceId: string; role: 'admin' | 'member'; }

export interface InvitationRepository {
  redeem(input: { userId: string; tokenHash: Buffer }): Promise<RedeemInvitationResult>;
}
