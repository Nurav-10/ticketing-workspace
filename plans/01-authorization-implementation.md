# Phase 1 authorization and workspace implementation blueprint

**Status:** proposed product and implementation contract · 14 November 2026. The policy matrix, bootstrap procedure, private-team rules, invitation issuance/revocation flows, and last-owner enforcement below are proposals for review; they are not implemented or approved behavior. This document does not select an identity provider or claim sign-in works.

**Scope:** define workspace membership authorization, role permissions, workspace bootstrap, private-team visibility, authorized invitation issue/revoke/redeem, cross-workspace query boundaries, database invariants, and transaction behavior. Authentication and app-session issuance remain in [the identity proposal](01-identity-implementation.md). The latest backend direction is Express + Prisma; preserve the behavior while that migration is completed.

## 1. Observed repository state and dependencies

- `apps/api/prisma/schema.prisma` and `apps/api/src/db/migrations/001_identity_workspaces.sql` define users, workspaces, workspace memberships, teams, team memberships, and invitations. Workspace membership roles are constrained to `owner`, `admin`, and `member`; a partial unique index allows at most one owner per workspace. It does not currently require at least one owner.
- Team visibility is constrained to `workspace` or `private`. Composite foreign keys tie team memberships to a team and a workspace membership in the same workspace. They prevent a user from becoming a team member in a workspace where that user is not a workspace member.
- Invitations store a unique token hash, invited email, workspace, `admin` or `member` role, issuer user, expiry, redeemed timestamp, and revoked timestamp. An index supports workspace/email lookup. Issuance and revocation endpoints and their issuer authorization are not implemented.
- Current protected request identity is a `Principal` containing an internal `userId` and `sessionId`; the configured provider/session adapter is not implemented and the default authenticator fails closed. Request-provided user IDs, roles, and email claims are not principals.
- The current workspace API lists workspaces for the authenticated internal user. The current invitation API redeems a hashed token after locking the invitation and user, requiring a verified email match, and creating the workspace membership in one Prisma transaction. Email comparison currently trims surrounding whitespace and lowercases only. Existing integration coverage includes workspace-local team-membership foreign keys, invitation expiry/revocation/replay, matching and mismatching verified addresses, duplicate membership, and concurrent redemption.
- Phase 1 explicitly defers the role matrix, private-team access, bootstrap, and owner succession until they are defined. The identity proposal requires those decisions before enabling administration or invite issuance. Phase 0 scope, deployment, identity provider choice, and real provider authentication remain prerequisites or separate work.

Until an authenticator resolves a real verified session, every protected endpoint remains unavailable/fail-closed. Do not introduce a test identity or a trusted role claim to make these flows appear active.

## 2. Proposed vocabulary and invariants

| Term | Proposed meaning |
| --- | --- |
| User | An internal application account identified by stable `users.id`; provider subject and email are not authorization keys. |
| Workspace | The tenant boundary for membership and workspace-owned records. A user may be a member of more than one workspace. |
| Workspace membership | The current, database-backed grant for one user in one workspace, with exactly one role. |
| Owner | The single workspace member allowed to transfer ownership and perform the highest-impact workspace administration. |
| Admin | A workspace member allowed to administer ordinary workspace membership, teams, and member invitations, within the private-team boundary below. |
| Member | A normal workspace member with access to workspace-visible teams and no workspace-administration authority. |
| Workspace-visible team | A team whose records are visible to every active member of its workspace; team membership rows do not narrow this visibility. |
| Private team | A team whose records are visible only to active workspace members with an explicit team-membership row. Workspace role does not itself grant content access. |
| Pending invitation | A stored invitation with no `redeemed_at` or `revoked_at` and an `expires_at` later than the database's current transaction time. Expiry is derived, not a mutable stored state. |

Proposed authorization invariants:

1. Authentication resolves an active internal user. Workspace authorization reads the current membership and role from PostgreSQL on each request or mutation; a principal, cookie, provider claim, URL, or email domain does not carry workspace authority.
2. Every protected workspace operation has an explicit workspace ID and a current membership check. Every team-owned operation additionally checks that the team belongs to that workspace and applies the team's visibility rule. Tenant filters are part of the actual repository query, not a UI filter.
3. A workspace has exactly one owner at every committed state. No ordinary role change, member removal, self-leave, account disablement, or user deletion may leave a live workspace without an owner.
4. Invitation roles are `admin` or `member`; an invitation can never grant owner. Only the invited, currently verified email can redeem it. A successful redemption creates one membership and consumes one invitation atomically.
5. No operation grants membership in one workspace by using a team, invitation, resource, or user relationship from another workspace.
6. Guests, custom roles, domain-wide auto-join, self-serve workspace creation after bootstrap, and provider-managed groups/roles are outside this Phase 1 proposal.

## 3. Proposed workspace permission matrix

These are proposed defaults to replace the unresolved role question in the Phase 1 plan. They assume the resource is in a workspace where the caller has an active membership.

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Read workspace metadata and member directory | Yes | Yes | Yes |
| Edit workspace name/settings | Yes | Yes | No |
| Create a workspace after the one-time bootstrap | No | No | No |
| Invite a verified email as admin | Yes | No | No |
| Invite a verified email as member | Yes | Yes | No |
| List pending invitations | Yes | Yes | No |
| Revoke pending admin or member invitation | Yes | No | No |
| Revoke pending member invitation | Yes | Yes | No |
| Promote/demote a regular member to/from admin | Yes | No | No |
| Remove a member | Yes | Yes, member role only | No |
| Remove/demote an admin | Yes | No | No |
| Transfer workspace ownership | Yes | No | No |
| Leave workspace voluntarily | Yes, only after transferring ownership in the same transaction | Yes | Yes |
| Create, rename, archive a team; set its initial visibility | Yes | Yes | No |
| Add/remove a user from a private team | Yes | Yes | No |
| Read workspace-visible team records | Yes | Yes | Yes |
| Read private-team records | Only if an explicit team member | Only if an explicit team member | Only if an explicit team member |
| Change an existing team's visibility | No in the initial release | No in the initial release | No |

Clarifications proposed with this matrix:

- Owners and admins can administer private-team metadata and membership, but that administrative role does not bypass private content access. They must also be a team member to read private-team issues, comments, attachments, activity, counts, or search results.
- Private-team membership is not self-service in Phase 1. An owner or admin adds/removes active workspace members. Team members may not promote themselves or add other users.
- `team_memberships` is an access grant for a private team. For a workspace-visible team, an explicit row is not required for workspace content access; any future assignment/routing use must have a separate documented meaning and cannot be mistaken for access control.
- Visibility is chosen when a team is created and immutable in Phase 1. Converting a populated workspace-visible team to private can silently hide existing content; converting a private team to workspace-visible can disclose it. A later conversion feature needs an explicit impact preview, authorization and audit contract.
- The member-level actions on future issue/project resources remain governed by their own feature plans. This document defines the outer workspace/team visibility gate, not issue lifecycle policy.
- Workspace deletion is deferred. Do not rely on the schema's cascading foreign keys to silently delete member, invite, team, or audit history through an unreviewed endpoint.

## 4. Proposed private-team and tenant query rules

The authorization service should expose small behavior-level checks such as `requireWorkspaceRole(userId, workspaceId, allowedRoles)` and `requireTeamAccess(userId, workspaceId, teamId, action)`. Routes only parse transport data and call the service; they must not decide authority from client-supplied role fields.

For a workspace-owned record, a read or write query must constrain both the object and the workspace, and require an active membership for the principal. A team-owned read/write additionally requires that the `team_id` resolves inside that same `workspace_id` and that either:

- the team is `workspace` visible and the user is an active workspace member; or
- the team is `private` and the user is an active workspace member with a matching `(workspace_id, team_id, user_id)` team-membership row.

Example predicate shape for future team content (illustrative SQL, not an implemented query):

```sql
SELECT r.*
FROM team_records AS r
JOIN teams AS t
  ON t.workspace_id = r.workspace_id AND t.id = r.team_id
JOIN workspace_memberships AS wm
  ON wm.workspace_id = r.workspace_id AND wm.user_id = $principal_user_id
WHERE r.workspace_id = $requested_workspace_id
  AND r.id = $record_id
  AND (t.visibility = 'workspace' OR EXISTS (
    SELECT 1 FROM team_memberships AS tm
    WHERE tm.workspace_id = t.workspace_id
      AND tm.team_id = t.id
      AND tm.user_id = $principal_user_id
  ));
```

Use an active-user predicate from the identity work once `users.status` exists. Until then, the real authenticator must reject disabled users; the current schema has no status column, so that behavior cannot yet be enforced by database queries.

Apply the same predicate to direct object reads, updates/deletes, nested relations, aggregate counts, search, pagination, exports, attachment delivery, webhooks, notifications, events/subscriptions, audit views, background jobs, and cache keys. Do not first load an object by globally unique ID and then authorize based only on its returned workspace. Do not leak private-team existence, names, counts, issue keys, or activity to a nonmember through search/autocomplete or error text.

Proposed disclosure contract: unauthenticated/expired session is `401`; a known workspace action for an authenticated workspace member who lacks the required administrative role is `403`; resources outside the caller's workspace or inside an inaccessible private team are consistently `404` to avoid an existence oracle. A missing workspace and an inaccessible workspace-owned object should have equivalent not-found envelopes. Rate limits and audit events still distinguish internal outcomes without logging tokens or private content.

Application-scoped queries and relational constraints are required regardless of whether PostgreSQL RLS is adopted. The Phase 1 plan leaves RLS as an option; this proposal does not introduce RLS. If a later decision enables it, use a non-owner/non-`BYPASSRLS` runtime role, transaction-scoped tenant/user context, `SET LOCAL`, and tests across pooled connection reuse; never treat RLS as a replacement for service authorization.

## 5. Proposed one-time workspace bootstrap

There is no unrestricted workspace signup. The first workspace is created from a verified provider identity and an operator-held bootstrap secret. This avoids requiring an existing local account before the first account can be created. The identity provider proves identity; it does not supply an owner role.

Proposed flow:

1. The operator explicitly configures the hash of a 32-byte random secret and the initial workspace name and slug. No default secret or request-provided workspace settings are accepted.
2. A rate-limited, controlled setup flow verifies the provider identity and email. Only a server-derived secret hash is carried in the encrypted, single-use login transaction; the raw secret must not appear in URLs or logs.
3. The bootstrap service checks the grant in constant time. In one database transaction, it obtains an advisory lock, verifies no workspace exists, and creates the internal user, provider identity, workspace and owner membership together.
4. A concurrent attempt waits for the lock, rechecks workspace existence and fails without creating a second workspace. Once any workspace exists, additional users join through authorized invitations only.

The internal service is drafted but the setup flow, rate limiting, audit event and provider integration are not yet wired or verified. Do not expose bootstrap publicly until these controls are complete.

If the provider/session/database contract is not working, bootstrap is not available. A private operator SQL insert is not a substitute for the auditable bootstrap service; any emergency recovery must be a separately documented, reviewed operations procedure.

## 6. Proposed invitation lifecycle and permissions

### States

An invitation is created as pending with an expiry. It transitions exactly once to redeemed or revoked; expiry makes it unusable without changing its stored row. A redeemed invitation cannot be revoked; a revoked or redeemed invitation cannot be reused. Resending means revoking the old invitation and issuing a fresh token. Never change a consumed row back to pending.

```text
new -> pending -> redeemed
              -> revoked
              -> expired (derived from expires_at; no state rewrite required)
```

### Issue

- Proposed endpoint: `POST /api/v1/workspaces/:workspaceId/invitations`. Authenticated owner may issue `admin` or `member`; authenticated admin may issue `member`; member is denied.
- The request includes only normalized candidate email and allowed role. Workspace comes from the path. The route rejects `owner`, provider subject, workspace owner ID, inviter ID, token hash, expiry override, and any unknown fields.
- Policy checks a current active workspace membership and role, validates a nonempty email, applies trim + lowercase only for comparison, rejects an already-member email, and applies a proposed default seven-day expiry with a hard maximum of thirty days. No Gmail dot/plus rewriting, domain auto-join, Unicode lookalike equivalence, or email-based account linking is proposed.
- Generate at least 32 cryptographically random bytes; return the raw bearer token only to the delivery adapter and never to the API response, logs, audit metadata, or database. Persist only a SHA-256 token hash. Store the invitee address and role. A provider-verified email is required at redemption.
- Proposed duplicate rule: at most one non-redeemed, non-revoked invitation for a given `(workspace_id, trim-lower(email))`. Before inserting, lock matching invitations for the workspace/email; mark an already expired one revoked and issue a fresh row. Keep `expires_at > now()` out of a partial-index predicate because a time-dependent predicate cannot safely maintain itself as time passes.
- Delivery is an external side effect and is not part of a PostgreSQL transaction. Commit the invitation row first, then call the injected mail sender. If delivery definitively fails, mark that invitation revoked in a second transaction and report delivery failure. If provider delivery outcome is uncertain, leave the invitation pending and let an owner/admin revoke and issue a fresh token; do not persist raw invite tokens to enable retry. Until a real delivery adapter exists, keep invitation issue endpoints disabled.

### Revoke

- Proposed endpoint: `DELETE /api/v1/workspaces/:workspaceId/invitations/:invitationId` or an equivalent `POST .../revoke`; exact REST shape is a transport choice, not a policy change.
- Within a transaction, lock the workspace, re-read the actor's current membership, enforce owner/admin role scope from the matrix, and update only an invitation matching both the requested workspace and invitation ID that is still pending and unexpired. Revoke is idempotent for the same actor and same workspace, but does not reveal an invitation from another workspace. Attempting to revoke a redeemed invite returns conflict; an already revoked/expired invitation can return the stable unavailable/not-found response.
- Send a revocation notice only after commit, if product policy later decides that is useful. Delivery failure does not restore a usable token.

### Redeem

- The current proposed contract matches the existing repository direction: the request supplies only the raw token; middleware supplies the verified internal `userId`. Hash the raw token before persistence lookup; never log it.
- Start one transaction. Resolve the candidate invite's workspace ID using its token hash; lock the workspace row; then lock/re-read the invitation and recipient user; confirm the row still belongs to that workspace/hash, has no redeemed/revoked timestamp and `expires_at > transaction_timestamp()`; confirm the user's current email is verified and `trim-lower(user.email) = trim-lower(invitation.email)`; create exactly one workspace membership with the invite's stored role; set `redeemed_at`; insert an audit event; commit.
- The invite's role is authoritative. A caller cannot request or upgrade a role at redemption. An email mismatch/unverified user does not consume the invitation. A unique-membership conflict returns `409 already_a_member` and rolls back without consuming the invite. A concurrent token replay has one winner; the later request sees redeemed and gets the established unavailable `404` behavior. A second distinct invitation for the same user/workspace loses on the membership unique key and rolls back its consumption.
- Invitation lookup must not reveal whether a token belongs to a workspace before email proof. Return the same unavailable response for unknown, expired, revoked, and already redeemed tokens. Email mismatch may return a generic verification error but must not reveal invite metadata.

## 7. Proposed membership administration and last-owner safety

Workspace role and membership changes are privileged mutations. Proposed endpoints are scoped under `workspaces/:workspaceId`; their schemas do not accept role authority in identity/session claims.

- Only an owner can promote/demote `member` and `admin` roles or transfer ownership. Generic role changes cannot create a second owner; transferring is a distinct operation.
- An owner can remove an admin or member. An admin can remove a member only. Neither can remove another owner; the owner cannot remove or leave as owner until ownership transfers in the same transaction.
- An admin/member may leave their own workspace. The only owner must transfer ownership before leaving. Removing/expiring membership immediately denies future workspace and team reads/writes. Proposed behavior is to retain the user's account and memberships in other workspaces; removing one membership must not globally disable the user.
- Removing a workspace membership cascades that user's private-team memberships through the existing composite FK. Future issues/audit records must not be erased by a membership removal unless the feature-specific retention policy explicitly says so.
- Demotion or removal of a user who owns a workspace is blocked until transfer. Account deactivation/deletion is similarly blocked or requires one atomic ownership transfer per owned workspace. The identity plan has not chosen account deletion/retention behavior; keep those endpoints unavailable until it does.

Ownership transfer is one transaction: lock workspace; lock the current owner and target users in deterministic ID order; lock/read both workspace-membership rows; require the actor is the current owner and the target is an active member of that workspace; update the former owner's membership to `admin` (proposed default) and target membership to `owner`; record actor, target, and time in the audit log; commit. The existing partial unique index provides an at-most-one-owner constraint. A deferred constraint trigger or equivalent database invariant must run for workspace insertion and membership owner changes/deletions, then ensure every non-deleted workspace has at least one owner at commit. Do not rely on a service-only check for the last owner. Existing integration fixtures that insert the workspace and owner in separate autocommit statements must create both in one transaction before this invariant is enabled.

The current schema's `workspace_single_owner` index only prevents a second owner. It does not prevent zero owners. Proposed migration work adds a deferred constraint trigger for workspace membership owner changes/deletions (or an equivalent reviewed ownership table design) that checks the final transaction state and rejects a live workspace with zero owners. The trigger must be compatible with bootstrap and the old-owner/new-owner transfer transaction. Workspace deletion is deferred so the constraint does not need a public cascade-delete exception. Keep the partial unique index as the at-most-one half of the invariant.

## 8. Proposed database constraints and migration requirements

Preserve the existing constraints and add migration SQL wherever Prisma cannot represent the complete invariant. Keep the Prisma schema and database migration equivalent; do not treat the generated schema alone as proof of PostgreSQL constraints.

| Entity | Existing baseline | Proposed requirements |
| --- | --- | --- |
| `users` | UUID primary key, unique `provider_subject`, nonempty email. | Identity proposal replaces single provider subject with unique `(issuer, subject)` identity rows and adds active/disabled account status. Do not use email as identity. Keep workspace FKs on stable internal user UUID. |
| `workspaces` | UUID primary key, unique lowercase slug, nonempty name, timestamps. | Preserve slug/name checks. Add the deferred at-least-one-owner check on workspace insertion as well as membership role changes/deletes. Treat workspace ID as the tenant key in every dependent FK and repository predicate. No public cascade delete endpoint in Phase 1. |
| `workspace_memberships` | PK `(workspace_id,user_id)`, role check, at-most-one owner partial unique index, workspace/user FKs. | Preserve one role per user/workspace. Add a deferred DB check/trigger that enforces at least one owner at commit. All role/membership changes go through locked service transactions; raw admin SQL is not a supported workflow. |
| `teams` | `UNIQUE(workspace_id,id)`, `UNIQUE(workspace_id,key)`, visibility check and workspace FK. | Preserve composite identifiers and visibility check. Visibility immutable after creation in Phase 1. |
| `team_memberships` | PK `(team_id,user_id)`; composite FKs to `(workspace_id,team_id)` and `(workspace_id,user_id)`. | Preserve both tenant-local FKs and cascade removal of a workspace membership. App queries check private visibility on every read/write. Add an index on `(workspace_id,user_id,team_id)` if query plans require it; verify by evidence. |
| `invitations` | UUID PK, workspace FK, issuer user FK, role check excludes owner, unique token hash, expiry, redeemed/revoked timestamps, nonempty email, mutually exclusive terminal timestamps, workspace/lower-email index. | Require 32-byte SHA-256 hash length; preserve role/email/state checks; check expiry later than creation; add one pending normalized-email-per-workspace partial unique index over `lower(btrim(email))` where `redeemed_at IS NULL AND revoked_at IS NULL`; retain the workspace+email lookup index if needed. Store no raw token. Use `invited_by` as issuance actor snapshot; issuer need not remain a member for history. |
| `workspace_audit_events` (new proposal) | Not present. | Append-only event rows for workspace bootstrap, invitation issue/revoke/redeem, membership role/removal, team visibility/membership and owner transfer. FK to workspace; actor/target IDs may be nullable for retained history according to deletion policy. No token, session, or raw private content. Write the event in the same transaction as the state mutation. Restrict update/delete to migration/retention procedure, not app runtime role. |

Use `ON DELETE CASCADE` only for dependent access-grant rows where deletion semantics are deliberate (the existing team memberships are an example). Keep invitation/audit retention policy separate from account removal; deleting an issuer user must not accidentally invalidate history or block normal membership removal. Before changing current FKs, resolve this with the identity plan's user-retention decision.

All index and trigger migrations must work on a fresh isolated database and must be additive/reviewed for any existing development data. Never reset or drop the existing development database. Do not enable RLS in this blueprint; if selected later, make a separate migration/role/connection-pool design and prove it through real pooled tests.

## 9. Proposed transaction boundaries and lock order

All policy checks for a mutation and its writes belong in one application-service transaction. Prisma repositories own SQL, lock statements, and the transaction boundary; routes do not open transactions. For authorization-sensitive mutations, use an explicit reviewed SQL row lock where required rather than assuming that a Prisma interactive transaction alone serializes read-then-write decisions.

Proposed lock order for ordinary workspace mutations: `workspace row -> affected user rows sorted by UUID -> workspace membership rows sorted by user UUID -> invitation rows sorted by invitation UUID -> team rows sorted by team UUID -> team-membership rows sorted by (team,user)`. Bootstrap starts with one transaction advisory lock, then the user/workspace rows it needs. The token lookup used before redemption is an unlocked discovery read only; after it resolves `workspace_id`, lock and re-read every relevant row in the declared order. If a workflow needs another order, redesign it or document and test the deadlock case before implementation.

| Workflow | One-transaction work | External/after-commit work | Failure/atomicity contract |
| --- | --- | --- | --- |
| First-workspace bootstrap | Acquire global bootstrap advisory lock; check gate and empty workspace set; lock/check active principal user; create workspace, owner membership and audit event; commit. | Disable setup flag operationally after success. | Concurrent call sees completed bootstrap and creates nothing; failed transaction leaves no partial workspace/owner. |
| Issue invitation | Lock workspace; lock/recheck inviter user and membership role; lock matching pending invitation rows; expire/revoke prior expired match; insert hash-only invite and audit event; commit. | Send email through injected adapter. | Unauthorized request writes nothing. Delivery failure revokes the pending invitation in a second transaction; uncertain delivery remains pending and must be explicitly revoked before reissue. |
| Revoke invitation | Lock workspace; lock/recheck actor and membership; lock invite scoped to workspace; authorize its stored role; set `revoked_at`; append audit event; commit. | Optional revocation email after commit. | Wrong workspace/inaccessible invite is not found; concurrent redeem/revoke has one serial winner. |
| Redeem invitation | Discover workspace from token hash; lock workspace; lock/recheck invite and active recipient; lock/check verified email; create membership; mark redeemed; audit; commit. | No email side effect in transaction. | Any guard/unique failure rolls back both membership and redemption. One concurrent redeemer wins. |
| Role change/removal | Lock workspace; lock actor/target users and memberships; authorize exact role transition; reject owner mutation except dedicated transfer; apply role/delete; cascade private memberships; write audit; commit. | Session revocation only if the selected identity policy requires it; membership authorization is rechecked immediately regardless. | No write on invalid authority; target cannot evade last-owner rule or affect another workspace. |
| Owner transfer | Lock workspace; lock both users and membership rows deterministically; verify actor owns and target is active member; demote current owner then promote target in one transaction; audit; deferred DB check; commit. | Notify both users after commit if notification is implemented. | At every committed state one owner; no mid-transaction state is visible; any failure restores the prior owner. |
| Add/remove private-team member | Lock workspace; lock actor and target users/memberships; lock team; verify actor owner/admin, target active workspace member, team private; insert/delete membership and audit; commit. | Optional notification after commit. | Cross-workspace targets fail via both service check and composite FK; no private access can be created for a nonmember. |

Use PostgreSQL transaction time consistently for expiry checks. Prefer READ COMMITTED with explicit row locks plus unique/check constraints for these small state machines, unless a demonstrated invariant needs serializable isolation. For serialization/deadlock retries, retry only known transient database codes, with a bounded count and jitter; never retry a consumed invite into a second membership. Normalize/translate unique conflicts to stable `409` codes without exposing SQL details.

## 10. Proposed module responsibilities and API seams

- `auth/`: real session authentication later resolves active internal `userId`; provider adapter never assigns workspace roles.
- `http/`: require authentication/origin for protected routes, validate bounded input, map errors and preserve request IDs.
- `authorization/` or equivalent small feature module: role matrix and private-team decision functions that consume a DB-backed membership/team context; no Express or Prisma types in domain policy.
- `workspaces/`: list only the principal's current workspace memberships; bootstrap and settings services; owner transfer and membership changes if approved.
- `teams/`: create/update visibility-at-creation, scoped team queries and private-team membership management.
- `invitations/`: issuer permission checks, token creation/hash, delivery port, revoke service, redemption service; transactional repository owns SQL locks and commits.
- `audit/`: append-only audit port/repository called inside the business transaction.
- Composition root injects one Prisma client and service dependencies. Do not add generic repository abstractions or speculative policy frameworks.

Proposed first API seams (exact URI shape may follow existing conventions):

- `GET /api/v1/workspaces`: current active memberships only; already represented in the scaffold.
- `POST /api/v1/setup/workspace`: operator-enabled, authenticated, one-time bootstrap.
- `POST /api/v1/workspaces/:workspaceId/invitations`: owner/admin role rules above; disabled until delivery exists.
- `GET /api/v1/workspaces/:workspaceId/invitations`: owner/admin only; returns safe metadata without token/hash.
- `DELETE /api/v1/workspaces/:workspaceId/invitations/:invitationId`: scoped revoke.
- `POST /api/v1/invitations/redeem`: existing token flow, completed with active-user/session checks and audit.
- Later workspace membership, owner-transfer, team, and private-team endpoints follow the policy matrix and are not enabled until their database and audit behavior are implemented.

## 11. Proposed integration and HTTP scenarios

Run only against the isolated Docker test PostgreSQL service and the actual API pool after implementation. The cases below are acceptance contracts, not claims that these tests already exist or pass.

### Schema and tenant constraints

1. A workspace can be bootstrapped with one owner; duplicate membership and duplicate owner constraints reject invalid writes. A transaction attempting to remove/demote the only owner fails at commit; atomic transfer succeeds and preserves exactly one owner.
2. Two workspaces and users prove composite team/team-membership FKs reject a team ID from workspace A paired with workspace B and reject a user without membership in the referenced workspace.
3. A private-team membership cannot reference a user in another workspace; deleting one workspace membership removes only that user's team-membership rows in that workspace.
4. Invalid role, visibility, empty name/email, owner invitation role, malformed token hash, conflicting redeemed/revoked state, and duplicate pending normalized invite constraints fail in PostgreSQL.
5. Prisma migration from a clean database preserves SQL-only checks, owner index/trigger, composite FKs, partial invite index and audit immutability privileges; baseline adoption never replays destructive DDL on the development volume.

### Authorization role matrix

6. For owner/admin/member actors, assert each workspace settings, invite admin/member, list/revoke invite, change role, remove member, transfer owner, team administration, and private-team membership operation against the entire matrix.
7. Admin cannot grant admin or owner, revoke an admin invite, remove/demote admin, transfer owner, or read private team content merely due to admin role. Member cannot administer workspace/team/invitation membership.
8. Owner/admin without private-team membership cannot read records, search hits, counts, attachment/download endpoints, activity or subscription events from that team; adding the actor as a team member grants access; removing it revokes access on the next request.
9. Workspace-visible team data is readable only by active members of that same workspace. Guessed IDs in another workspace return the same not-found behavior as missing IDs. A user in workspace A can still access A after being removed from B and cannot access B.
10. Revoked workspace membership or disabled account is effective immediately across repeated requests and pooled DB connections; no connection-local tenant/principal context leaks to the next pooled request.

### Bootstrap and owner succession

11. Anonymous, inactive, unverified (if verification is required for bootstrap), disabled-gate, malformed payload, and already-completed bootstrap attempts create no workspace. The request cannot choose another owner or role.
12. Two concurrent bootstrap requests under different authenticated users result in one workspace/owner and one controlled conflict; an injected failure between writes rolls back the entire workspace bootstrap.
13. Only the owner can transfer ownership; target must be an active member. Concurrent owner transfer and owner-removal operations serialize; there is never a committed ownerless workspace.
14. Owner self-leave/removal is blocked until transfer; after transfer the former owner follows the proposed demoted admin role and may leave as a normal member. User disable/delete handling is denied when it would strand any owned workspace.

### Invitations

15. Owner can issue admin/member invites; admin can issue member only; member cannot issue. Client-supplied workspace, role, issuer, token hash, or user ID cannot override server context.
16. Only workspace-scoped owner/admin can list invitations. Owner can revoke admin/member invite; admin can revoke member invite only. Cross-workspace invite IDs cannot be revoked or enumerated.
17. Mail transport receives the raw one-time token but response, DB, logs, audit, and error bodies contain only safe invitation metadata/hash. Definitive delivery failure revokes the row; uncertain delivery cannot mint a second active invitation without first revoking the old one.
18. Verified trim/lower matching email redeems; mismatch, unverified email, changed email, expired/revoked/redeemed token, and unknown token fail without membership or token leakage. Email mismatch does not consume a still-valid invitation.
19. Two concurrent redemptions of one token produce exactly one membership and one redeemed timestamp. Two different pending invites for the same user/workspace produce one membership; the losing transaction leaves its invitation unredeemed and returns `409 already_a_member`.
20. Concurrent issue for the same normalized email produces one active pending invitation; concurrent revoke/redeem has one serial winner; failed transaction leaves neither partial membership nor consumed invite; bounded serialization retries do not replay a side effect.

### Delivery and privacy

21. Every protected endpoint rejects missing/expired session; unsafe cookie-authenticated writes reject missing or untrusted Origin as specified by the identity/API boundary. No header/body/query role or provider group can authorize.
22. Private-team names/counts/search/activity are not visible through alternate routes, paginated totals, caches, websocket/event streams, exports, logs, or background notification recipients to nonmembers.
23. Structured logs and audit rows have request/actor/target/workspace/time/outcome sufficient for review but omit raw invitation/session/OIDC secrets and private record content. API error envelopes follow the existing `400/401/403/404/409` contract without raw database errors.

## 12. Implementation slices and gates

1. **Proposed policy defaults:** implement the matrix, private-team rule, bootstrap route, invitation role/expiry/delivery contract, owner invariant, and RLS deferral as written unless product/security direction supersedes them. Keep routes unavailable until the corresponding identity, persistence, and delivery dependencies exist.
2. **Identity/persistence prerequisites:** complete the selected identity proposal's provider-neutral internal-user/session model, verified-principal behavior, user status, and Express/Prisma migration. Keep production fail-closed until the selected provider is actually configured.
3. **Invariant migration:** add reviewed Prisma migration SQL for at-least-one-owner, active invite uniqueness/token length and audit table/privileges; preserve existing partial unique owner index and composite tenant foreign keys. Prove fresh DB and safe baseline adoption in Docker without resetting the development database.
4. **Authorization query layer:** implement role gate and workspace/private-team query predicates in services/repositories. Add membership/team endpoints only with the matrix and response disclosure contract. Ensure every request path—including background/event delivery—has the same scope.
5. **Bootstrap and owner management:** add advisory-locked one-time workspace creation, role changes, member removal, transfer, membership departure, audit writes and concurrent failure handling.
6. **Invitation issue/revoke/delivery:** implement authorized issuance, secret hashing, duplicate pending rule, post-commit delivery/error compensation, scoped list and revocation. Do not activate these routes before a real sender and retry/revoke UX are available.
7. **Redemption integration:** retain the existing atomic redemption seam, add current active user checks, normalized invite uniqueness policy, audit event, deterministic locking and public HTTP contract.
8. **Full verification:** run static checks, migrations, APIs, role matrix, pooled-connection and two-connection concurrency integration scenarios only inside Docker against the isolated test database. Review the dependency safety gate for any manifest/lock changes. Record exactly what is not covered and do not claim Phase 1 acceptance until all foundational, identity, CI, staging and operations gates are complete.

## 13. Proposed defaults and external dependencies

The policy choices above are implementation-ready proposed defaults, not blockers requiring a separate approval turn. They can be implemented as written unless product/security direction changes them. Defaults are: admins can view the member directory and pending member invites; workspace administrators can manage private-team metadata without bypassing private content; invitations are delivered after commit without persisting raw tokens; bootstrap and invitation redemption require verified identity; RLS is deferred; visibility is immutable during Phase 1; workspace deletion is deferred; and audit rows retain safe actor/target metadata without tokens or private content.

External dependencies that still need real configuration or a separate product/operations decision are: selection and configuration of the OIDC provider and app sessions; an actual invitation delivery provider; user disablement/deletion and audit/PII retention policy; deployment controls for the one-time bootstrap switch; and the runtime database role/hosting environment. Keep dependent endpoints unavailable and fail closed until those seams exist. The implementation may build and integrate the provider-neutral policy, schema, and service boundaries before live provider/mail configuration.

No policy, endpoint, audit schema, database trigger, provider, or account was changed by writing this proposal. The database scenarios are acceptance criteria for the later implementation; no tests or migrations were run for this planning task.
