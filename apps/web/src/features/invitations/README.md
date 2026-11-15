# Invitations web slice

`InvitationManager` is mounted for the selected workspace's owner or administrator. Owners and admins can invite members; only owners can issue administrator invitations. Its API client calls the protected invitation endpoint, keeps the returned one-time code in component memory, and displays it for deliberate copy/share. A still-visible code must be explicitly hidden before another invitation can be issued or the workspace context changed. The `onPendingChange` callback reports when a request or visible code needs protection.

If an issuance response is lost or unusable, the server may have created an invitation without returning its one-time code. The UI marks this outcome as uncertain and lets an authorized administrator search by email and revoke a matching pending invitation before issuing a new code. The code itself cannot be recovered. If no result appears, the user should wait and search again before retrying; a request may still be in flight. Administrators can manage member invitations, while only owners can revoke administrator invitations.

`InvitationAcceptance` is a standalone code entry screen. Pass `authState="signed-in"` for an authenticated session or `authState="signed-out"` for an invitee who needs sign-in. Signed-in users redeem through the existing same-origin JSON endpoint. Signed-out users submit a native same-origin form to `/api/v1/auth/login`; the raw code stays in the POST body and is not added to the address bar. A 401 from redemption reveals the sign-in form as a recovery path. The parent can use `onAccepted` to refresh authenticated workspace data.

The shell mounts both components under expandable access controls. A real identity provider and browser-based onboarding verification are still required.
