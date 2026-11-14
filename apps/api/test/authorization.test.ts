import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideTeamAction,
  decideWorkspaceAction,
  type TeamFact,
  type TeamMembershipFact,
  type InvitationFact,
  type WorkspaceAction,
  type WorkspaceMembershipFact,
  type WorkspaceRole
} from '../src/authorization/policy.js';

const workspaceId = 'workspace-a';
const actorUserId = 'user-a';
const teamId = 'team-a';

function membership(role: WorkspaceRole, overrides: Partial<WorkspaceMembershipFact> = {}): WorkspaceMembershipFact {
  return { workspaceId, userId: actorUserId, role, isActive: true, ...overrides };
}

function team(visibility: TeamFact['visibility'], overrides: Partial<TeamFact> = {}): TeamFact {
  return { workspaceId, teamId, visibility, ...overrides };
}

function teamMembership(overrides: Partial<TeamMembershipFact> = {}): TeamMembershipFact {
  return { workspaceId, teamId, userId: actorUserId, ...overrides };
}

function workspaceAction(role: WorkspaceRole, action: WorkspaceAction) {
  const facts: Parameters<typeof decideWorkspaceAction>[0] = {
    requestedWorkspaceId: workspaceId,
    actorUserId,
    membership: membership(role)
  };
  if (action === 'changeMemberRole' || action === 'removeMember') {
    facts.targetUserId = 'target-member';
    facts.targetMembership = membership('member', { userId: facts.targetUserId });
  } else if (action === 'changeAdminRole' || action === 'removeAdmin') {
    facts.targetUserId = 'target-admin';
    facts.targetMembership = membership('admin', { userId: facts.targetUserId });
  } else if (action === 'transferOwnership') {
    facts.targetUserId = 'target-member';
    facts.targetMembership = membership('member', { userId: facts.targetUserId });
  } else if (action === 'revokeMemberInvitation' || action === 'revokeAdminInvitation') {
    facts.targetInvitationId = 'invitation-a';
    facts.invitation = invitation(action === 'revokeAdminInvitation' ? 'admin' : 'member');
  }
  return decideWorkspaceAction(facts, action);
}

function invitation(role: InvitationFact['role'], overrides: Partial<InvitationFact> = {}): InvitationFact {
  return { workspaceId, invitationId: 'invitation-a', role, isPending: true, ...overrides };
}

test('owner follows the proposed workspace administration matrix', () => {
  const allowed: WorkspaceAction[] = [
    'readWorkspace', 'manageWorkspaceSettings', 'inviteAdmin', 'inviteMember', 'listInvitations',
    'revokeAdminInvitation', 'revokeMemberInvitation', 'changeMemberRole', 'changeAdminRole',
    'removeMember', 'removeAdmin', 'transferOwnership'
  ];
  const denied: WorkspaceAction[] = ['leaveWorkspace'];

  for (const action of allowed) assert.deepEqual(workspaceAction('owner', action), { allowed: true, reason: 'allowed' }, action);
  for (const action of denied) assert.deepEqual(workspaceAction('owner', action), { allowed: false, reason: 'owner_transfer_required' }, action);
});

test('admin can manage workspace settings and member-level access only', () => {
  const allowed: WorkspaceAction[] = [
    'readWorkspace', 'manageWorkspaceSettings', 'inviteMember', 'listInvitations',
    'revokeMemberInvitation', 'removeMember', 'leaveWorkspace'
  ];
  const denied: WorkspaceAction[] = [
    'inviteAdmin', 'revokeAdminInvitation', 'changeMemberRole', 'changeAdminRole',
    'removeAdmin', 'transferOwnership'
  ];

  for (const action of allowed) assert.deepEqual(workspaceAction('admin', action), { allowed: true, reason: 'allowed' }, action);
  for (const action of denied) assert.deepEqual(workspaceAction('admin', action), { allowed: false, reason: 'forbidden' }, action);
});

test('member can read workspace metadata and leave, but cannot administer workspace access', () => {
  const allowed: WorkspaceAction[] = ['readWorkspace', 'leaveWorkspace'];
  const denied: WorkspaceAction[] = [
    'manageWorkspaceSettings', 'inviteAdmin', 'inviteMember', 'listInvitations',
    'revokeAdminInvitation', 'revokeMemberInvitation', 'changeMemberRole',
    'changeAdminRole', 'removeMember', 'removeAdmin', 'transferOwnership'
  ];

  for (const action of allowed) assert.deepEqual(workspaceAction('member', action), { allowed: true, reason: 'allowed' }, action);
  for (const action of denied) assert.deepEqual(workspaceAction('member', action), { allowed: false, reason: 'forbidden' }, action);
});

test('outsiders, inactive memberships, and mismatched membership facts cannot pass workspace checks', () => {
  const outsider = decideWorkspaceAction({ requestedWorkspaceId: workspaceId, actorUserId, membership: null }, 'readWorkspace');
  const inactive = decideWorkspaceAction({ requestedWorkspaceId: workspaceId, actorUserId, membership: membership('owner', { isActive: false }) }, 'manageWorkspaceSettings');
  const otherWorkspace = decideWorkspaceAction({ requestedWorkspaceId: workspaceId, actorUserId, membership: membership('owner', { workspaceId: 'workspace-b' }) }, 'manageWorkspaceSettings');
  const otherUser = decideWorkspaceAction({ requestedWorkspaceId: workspaceId, actorUserId, membership: membership('owner', { userId: 'user-b' }) }, 'manageWorkspaceSettings');

  for (const decision of [outsider, inactive, otherWorkspace, otherUser]) {
    assert.deepEqual(decision, { allowed: false, reason: 'not_a_member' });
  }
});

test('workspace-visible team content is available to every active workspace member', () => {
  for (const role of ['owner', 'admin', 'member'] as const) {
    const decision = decideTeamAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: membership(role),
      requestedTeamId: teamId,
      team: team('workspace'),
      teamMembership: null
    }, 'readContent');
    assert.deepEqual(decision, { allowed: true, reason: 'allowed' }, role);
  }
});

test('workspace roles do not bypass private-team content membership', () => {
  for (const role of ['owner', 'admin', 'member'] as const) {
    const decision = decideTeamAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: membership(role),
      requestedTeamId: teamId,
      team: team('private'),
      teamMembership: null
    }, 'readContent');
    assert.deepEqual(decision, { allowed: false, reason: 'team_membership_required' }, role);
  }
});

test('private-team content requires a team membership matching workspace, team, and actor', () => {
  const matchingGrant = decideTeamAction({
    requestedWorkspaceId: workspaceId,
    actorUserId,
    membership: membership('member'),
    requestedTeamId: teamId,
    team: team('private'),
    teamMembership: teamMembership()
  }, 'readContent');
  assert.deepEqual(matchingGrant, { allowed: true, reason: 'allowed' });

  const mismatchedGrants = [
    teamMembership({ workspaceId: 'workspace-b' }),
    teamMembership({ teamId: 'team-b' }),
    teamMembership({ userId: 'user-b' })
  ];
  for (const grant of mismatchedGrants) {
    const decision = decideTeamAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: membership('member'),
      requestedTeamId: teamId,
      team: team('private'),
      teamMembership: grant
    }, 'readContent');
    assert.deepEqual(decision, { allowed: false, reason: 'team_membership_required' });
  }
});

test('team facts outside the requested workspace or team are treated as not found', () => {
  const mismatchedTeams = [team('workspace', { workspaceId: 'workspace-b' }), team('private', { teamId: 'team-b' })];
  for (const fact of mismatchedTeams) {
    const decision = decideTeamAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: membership('owner'),
      requestedTeamId: teamId,
      team: fact,
      teamMembership: null
    }, 'readContent');
    assert.deepEqual(decision, { allowed: false, reason: 'team_not_found_in_workspace' });
  }
});

test('only owners and admins manage teams; private membership changes are private-team-only', () => {
  for (const role of ['owner', 'admin'] as const) {
    assert.deepEqual(decideTeamAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: membership(role),
      requestedTeamId: teamId,
      team: team('workspace'),
      teamMembership: null
    }, 'manageMetadata'), { allowed: true, reason: 'allowed' }, role);

    assert.deepEqual(decideTeamAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: membership(role),
      requestedTeamId: teamId,
      team: team('private'),
      teamMembership: null,
      targetUserId: 'target-member',
      targetMembership: membership('member', { userId: 'target-member' })
    }, 'managePrivateMembership'), { allowed: true, reason: 'allowed' }, role);
  }

  for (const role of ['owner', 'admin', 'member'] as const) {
    const decision = decideTeamAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: membership(role),
      requestedTeamId: teamId,
      team: team('workspace'),
      teamMembership: null
    }, 'managePrivateMembership');
    assert.deepEqual(decision, { allowed: false, reason: role === 'member' ? 'forbidden' : 'not_a_private_team' }, role);
  }

  assert.deepEqual(decideTeamAction({
    requestedWorkspaceId: workspaceId,
    actorUserId,
    membership: membership('member'),
    requestedTeamId: teamId,
    team: team('private'),
    teamMembership: null
  }, 'manageMetadata'), { allowed: false, reason: 'forbidden' });
});

test('owner may leave only after a transaction has changed the trusted role fact', () => {
  assert.deepEqual(workspaceAction('owner', 'leaveWorkspace'), { allowed: false, reason: 'owner_transfer_required' });
  assert.deepEqual(workspaceAction('owner', 'transferOwnership'), { allowed: true, reason: 'allowed' });
  // A transfer service must perform this role change and departure atomically.
  assert.deepEqual(workspaceAction('admin', 'leaveWorkspace'), { allowed: true, reason: 'allowed' });
  assert.deepEqual(workspaceAction('member', 'leaveWorkspace'), { allowed: true, reason: 'allowed' });
});

test('private-team membership changes require an active target workspace member', () => {
  const base = {
    requestedWorkspaceId: workspaceId,
    actorUserId,
    membership: membership('admin'),
    requestedTeamId: teamId,
    team: team('private'),
    teamMembership: null
  };
  assert.deepEqual(decideTeamAction(base, 'managePrivateMembership'), { allowed: false, reason: 'target_fact_required' });
  assert.deepEqual(decideTeamAction({
    ...base,
    targetUserId: 'target-member',
    targetMembership: membership('member', { userId: 'target-member', workspaceId: 'workspace-b' })
  }, 'managePrivateMembership'), { allowed: false, reason: 'target_not_in_workspace' });
  assert.deepEqual(decideTeamAction({
    ...base,
    targetUserId: 'target-member',
    targetMembership: membership('member', { userId: 'target-member', isActive: false })
  }, 'managePrivateMembership'), { allowed: false, reason: 'target_not_in_workspace' });
  assert.deepEqual(decideTeamAction({
    ...base,
    targetUserId: 'target-member',
    targetMembership: membership('member', { userId: 'target-member' })
  }, 'managePrivateMembership'), { allowed: true, reason: 'allowed' });
});

test('target-sensitive member and invitation actions fail closed without trusted target facts', () => {
  const base = { requestedWorkspaceId: workspaceId, actorUserId, membership: membership('admin') };
  for (const action of ['removeMember', 'revokeMemberInvitation'] as const) {
    assert.deepEqual(decideWorkspaceAction(base, action), { allowed: false, reason: 'target_fact_required' }, action);
  }
});

test('admins cannot target owners or admins through member-only actions', () => {
  const admin = membership('admin');
  for (const targetRole of ['owner', 'admin'] as const) {
    const decision = decideWorkspaceAction({
      requestedWorkspaceId: workspaceId,
      actorUserId,
      membership: admin,
      targetUserId: 'target-user',
      targetMembership: membership(targetRole, { userId: 'target-user' })
    }, 'removeMember');
    assert.deepEqual(decision, { allowed: false, reason: 'target_type_mismatch' }, targetRole);
  }
});

test('membership target facts must match the requested workspace, target, and active role', () => {
  const base = { requestedWorkspaceId: workspaceId, actorUserId, membership: membership('owner') };
  const cases = [
    { targetUserId: 'target', targetMembership: membership('member', { userId: 'target', workspaceId: 'workspace-b' }), reason: 'target_not_in_workspace' },
    { targetUserId: 'target', targetMembership: membership('member', { userId: 'someone-else' }), reason: 'target_not_in_workspace' },
    { targetUserId: 'target', targetMembership: membership('member', { userId: 'target', isActive: false }), reason: 'target_not_in_workspace' },
    { targetUserId: 'target', targetMembership: membership('admin', { userId: 'target' }), reason: 'target_type_mismatch' }
  ] as const;
  for (const entry of cases) {
    assert.deepEqual(decideWorkspaceAction({ ...base, targetUserId: entry.targetUserId, targetMembership: entry.targetMembership }, 'removeMember'), {
      allowed: false,
      reason: entry.reason
    });
  }
});

test('invitation revocation requires a matching pending invitation of the authorized role', () => {
  const base = { requestedWorkspaceId: workspaceId, actorUserId, membership: membership('admin'), targetInvitationId: 'invitation-a' };
  const cases = [
    { invitation: invitation('admin'), action: 'revokeMemberInvitation' as const, reason: 'target_type_mismatch' },
    { invitation: invitation('member', { workspaceId: 'workspace-b' }), action: 'revokeMemberInvitation' as const, reason: 'target_not_in_workspace' },
    { invitation: invitation('member', { invitationId: 'invitation-b' }), action: 'revokeMemberInvitation' as const, reason: 'target_not_in_workspace' },
    { invitation: invitation('member', { isPending: false }), action: 'revokeMemberInvitation' as const, reason: 'invitation_not_pending' }
  ] as const;
  for (const entry of cases) {
    assert.deepEqual(decideWorkspaceAction({ ...base, invitation: entry.invitation }, entry.action), {
      allowed: false,
      reason: entry.reason
    });
  }
  assert.deepEqual(decideWorkspaceAction({ ...base, invitation: invitation('member') }, 'revokeMemberInvitation'), {
    allowed: true,
    reason: 'allowed'
  });
});

test('ownership transfer requires a different active member in the same workspace', () => {
  const base = { requestedWorkspaceId: workspaceId, actorUserId, membership: membership('owner') };
  assert.deepEqual(decideWorkspaceAction(base, 'transferOwnership'), { allowed: false, reason: 'target_fact_required' });
  assert.deepEqual(decideWorkspaceAction({
    ...base,
    targetUserId: actorUserId,
    targetMembership: membership('owner')
  }, 'transferOwnership'), { allowed: false, reason: 'target_type_mismatch' });
  assert.deepEqual(decideWorkspaceAction({
    ...base,
    targetUserId: 'target',
    targetMembership: membership('member', { userId: 'target' })
  }, 'transferOwnership'), { allowed: true, reason: 'allowed' });
});
