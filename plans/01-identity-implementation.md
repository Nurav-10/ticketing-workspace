# Phase 1 identity implementation decision and blueprint

**Status:** proposed implementation decision; no identity provider, account, domain, dependency or credential has been configured. No code in this document is implemented.  
**Scope:** replace the Phase 1 placeholder identity seam with hosted OIDC sign-in, app-owned sessions, user identity records and dependable logout/revocation. Workspace membership, invitation policy and product authorization remain application-owned.  
**Evidence reviewed:** official provider documentation and pricing pages checked 14 November 2026. Pricing and feature entitlements are time-sensitive and must be rechecked before selection or purchase.

**Implementation stack:** the current repository scaffold uses Fastify and handwritten SQL migrations. The latest project direction is **Express + Prisma**. This blueprint treats Express as the target HTTP adapter and Prisma as the target persistence/migration layer; migration of the existing scaffold is a prerequisite slice, not an already completed change. Preserve the existing authorization and transaction guarantees during that migration.

## 1. Decision summary

### Proposed direction

Use **Auth0 as the first candidate for a hosted OIDC provider**, behind the existing `Authenticator` boundary. This is a proposal, not a final vendor selection or procurement approval. Auth0's hosted Universal Login, standard OIDC authorization-code flow, email verification support, and documented refresh-token revocation appear to fit an initial hosted-login path. Its managed-login entry point and the intended architecture are supported by [Auth0 Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login), [Authorization Code Flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow), [email verification](https://auth0.com/docs/manage-users/user-accounts/verify-emails), and [refresh-token revocation](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens).

Keep **Amazon Cognito User Pools as the named alternative** if hosting is AWS-based, AWS operating familiarity is available, and a price/residency review favors it. Cognito documents hosted managed-login redirects, PKCE, nonce, email verification, refresh-token revocation and global sign-out. It also documents a crucial constraint: a revoked self-contained JWT can still pass a local library check that only validates signature and expiration. See [authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), [email verification](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-email-phone-verification.html), and [token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html).

The application will **not** use provider access or ID tokens as browser sessions. After validating the OIDC response on the API, the application will create a high-entropy opaque session token, persist only its hash, and set it in an HttpOnly cookie. The app database becomes the request-time authority for application sessions and membership authorization.

### Decision gates before implementation/configuration

This plan does not resolve the following product/operations unknowns: expected monthly active users and sign-in volume, budget, AWS or other hosting, required data residency/region, whether customers require enterprise federation/SSO or SCIM at beta, and support/incident ownership. Compare provider total cost at a documented traffic assumption, required feature tier, regional availability, support/SLA, email delivery, rate limits and contract terms. Record the selected provider, tenant/region, callback/logout origins, email-verification policy and cost estimate in the decision record before enabling deployment configuration.

Auth0 public pricing currently presents a Free tier with up to 25,000 monthly active users and one custom domain, with paid tiers/features and B2B offerings dependent on use case; the displayed figure is not a cost forecast or a promise that a needed feature is included. See [Auth0 pricing](https://auth0.com/pricing). AWS currently describes Cognito MAU pricing, tier differences, regional pricing and additional charges (including advanced security features and messaging); eligible free-tier rules differ by account/pool history. See [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) and [Cognito FAQ](https://aws.amazon.com/cognito/faqs/). Compare actual region-specific price calculators and confirm any email/SMS, custom-domain, logging, support and multi-region costs; do not put a guessed monthly figure in the product budget.

**Region is undecided.** Select it with the application database/hosting region and user location in view. Confirm provider tenant/pool region, data processing and support access, user-profile and log storage, email delivery region, backup/residency obligations and cross-region behavior. A region label alone is not proof that all personal data is resident there.

## 2. Current repository baseline and target boundary

Existing implementation facts reviewed:

- `apps/api/src/auth/authenticator.ts` defines a small `Principal` and `Authenticator`; `UnconfiguredAuthenticator` returns no principal and production startup rejects an unconfigured adapter. It describes provider-session verification but does not implement it.
- `apps/api/src/db/migrations/001_identity_workspaces.sql` creates `users` with one unique `provider_subject`, email and nullable `email_verified_at`; workspace/team memberships have `owner`, `admin`, and `member` workspace roles. The schema also has token-hash invitation fields, but invitation creation/issuer authorization is not complete.
- `apps/api/README.md` explicitly states that sign-in, cookie issuance/logout, real provider verification and invitation creation are not implemented. Existing invitation redemption is a persistence/service seam and cannot be considered an end-to-end authorized invite flow yet.
- `plans/01-foundations.md` and `plans/01-implementation-blueprint.md` call for a managed identity provider, secure cookie, identity linking, revocation, tenant isolation and strict logging behavior.
- The present scaffold's Fastify request types, SQL repositories and SQL migration runner are current implementation facts. They are not the target stack for this identity work after the Express + Prisma direction; migrate the HTTP/persistence seams coherently before wiring real login.

This plan adds no claim that provider login, sessions, account linking, invitations, bootstrap, deployment or acceptance tests currently work. It proposes the implementation contract for that work. Until slices in this document are completed, keep the API fail-closed; do not create a fake authenticated user or silently treat an email address as a provider identity.

### Express and Prisma module boundary

Express owns transport only: route registration, request parsing, middleware order, response/cookie behavior, centralized safe error mapping and request IDs. An Express auth middleware calls the application `Authenticator`, attaches a typed verified `Principal` to the request, and never trusts a user ID, role, issuer, subject or verification flag from headers/body/query. Feature services own identity resolution, login transaction policy, app-session policy, invitations and authorization. Prisma-backed repositories own typed persistence operations and transactions; the composition root creates one Prisma client and injects narrow ports. Domain/application policy must not import Express types or construct Prisma clients. Keep provider SDK imports inside the provider adapter.

Use Prisma schema models and versioned Prisma migrations for `users`, `user_identities`, `app_sessions`, memberships and invitations. Encode durable invariants in PostgreSQL constraints and indexes even where Prisma schema expresses the relation: compound unique `(issuer, subject)`, unique session hash, foreign keys, role/state checks where Prisma cannot model a check constraint, and tenant-safe composite keys. Add custom SQL to Prisma migrations for database checks/indexes that Prisma schema cannot represent. Keep data access parameterized; use Prisma's supported transaction APIs, and use raw SQL only for a reviewed operation Prisma cannot express safely.

Keep multi-record provisioning and redemption in a single Prisma transaction with the required isolation/locking semantics. For race-sensitive one-time operations (identity first-login, bootstrap, invitation redemption), rely on unique constraints as the final arbiter, handle uniqueness conflicts as a controlled retry/409 outcome, and use a serializable transaction or explicit reviewed row-lock query where read-then-write invariants otherwise race. Retry only known serialization/deadlock failures a bounded number of times; never retry a consumed invite into a second membership. Do not claim a Prisma transaction alone prevents races unless the isolation level and constraint behavior are demonstrated by PostgreSQL integration tests.

## 3. Identity and application model

### Durable external identity key

Use the OIDC pair **exact issuer string + subject string** as the durable external identity key: `(issuer, subject)`. Validate `iss` against the configured issuer exactly and use the `sub` from a validated ID token or trusted user-info result. Do not key or auto-link users by email, display name, provider-specific username, organization, or mutable profile claim. OIDC defines `sub` as locally unique and never reassigned within the issuer; uniqueness across issuers requires pairing it with `iss`. The OIDC stability requirement is in [OpenID Connect Core 1.0, Claim Stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).

Treat issuer as a normalized configuration value, not a user-entered string: store the exact canonical issuer advertised by provider discovery, require HTTPS except explicitly isolated local test fixtures, and compare exact values. Preserve subject bytes/case as returned. Do not normalize email for identity matching beyond the separately agreed invitation email comparison policy.

### Proposed relational shape

Keep the application `users.id` as the stable internal UUID referenced by workspaces, memberships, ownership, activity and future product records. Replace the single-provider field with an identity table that supports multiple linked OIDC identities:

```text
users
  id UUID PK
  email TEXT                         -- current profile value, not an identity key
  email_verified_at TIMESTAMPTZ NULL -- set only from validated verified claim/provider evidence
  display_name TEXT
  status TEXT CHECK (active | disabled) [proposed]
  created_at, updated_at

user_identities
  id UUID PK
  user_id UUID FK users(id) ON DELETE CASCADE
  issuer TEXT NOT NULL
  subject TEXT NOT NULL
  provider_email TEXT NULL           -- optional latest provider claim for profile/support
  provider_email_verified BOOLEAN NOT NULL DEFAULT false
  created_at, last_authenticated_at
  UNIQUE (issuer, subject)
  INDEX (user_id)

app_sessions
  id UUID PK
  user_id UUID FK users(id) ON DELETE CASCADE
  token_hash BYTEA NOT NULL UNIQUE
  created_at TIMESTAMPTZ NOT NULL
  last_seen_at TIMESTAMPTZ NOT NULL
  idle_expires_at TIMESTAMPTZ NOT NULL
  absolute_expires_at TIMESTAMPTZ NOT NULL
  revoked_at TIMESTAMPTZ NULL
  revoke_reason TEXT NULL
  [optional: auth_time / assurance context only if a concrete policy needs it]
```

This is a target shape, not a migration already applied. Use database constraints to make one external identity map to exactly one internal user. Sessions must not contain raw cookie tokens, provider ID/access/refresh tokens, or unneeded IP/user-agent history. If operational abuse investigation later requires request metadata, define collection, retention, access and redaction separately.

`email` and display name are mutable profile attributes. On every successful provider callback, update the identity's `last_authenticated_at`; update profile claims according to a documented policy without overwriting a verified app email with an unverified claim. `email_verified_at` means the app has accepted evidence for the current email value. If the email changes, clear the app's verified marker until the new value is verified. Whether an already verified address needs re-verification after provider/account changes must be explicit.

### Application authorization and roles

OIDC authenticates a person; it does not grant workspace access. Ignore provider role/group/organization metadata for application authorization in the first release. Load the internal user, status, workspace memberships and team memberships from PostgreSQL. The schema's current workspace roles remain `owner`, `admin`, `member`; continue to defer guests/custom roles. Each request checks `user.status = active`, current workspace membership and team visibility/access in the app service/repository. No role from a cookie, browser request, ID token custom claim, or email domain is authoritative.

Before implementation, explicitly define permission matrices for owner/admin/member and workspace-visible/private teams. Include invitation creation, revocation, role changes, membership removal, last-owner transfer, team visibility and membership updates. Until issuer permissions and bootstrap are defined, do not expose invitation creation or workspace administration endpoints.

## 4. Hosted OIDC login flow

### Server-mediated flow

Use a backend web application flow so all tokens remain server-side. The React app navigates to same-origin API endpoints (for example `/auth/login` and `/auth/callback`); the browser never receives provider tokens. The API redirects to provider-hosted Universal Login/managed login. Do not implement password collection or a home-grown password database.

1. **Start login (`GET /auth/login`)**: generate independent cryptographically random `state`, `nonce`, and PKCE `code_verifier`; derive `code_challenge` with `S256`. Store a short-lived, single-use server-side transaction keyed by a secure random transaction cookie or opaque handle, including state, nonce, verifier, exact expected issuer/client ID/callback URI, creation/expiry and a validated same-origin post-login path. Set a short-lived HttpOnly, Secure-in-production, SameSite=Lax transaction cookie. Do not accept arbitrary redirect URLs. Use authorization-code response type, `openid email profile` only if profile is required, and provider parameters for PKCE, state, and nonce.
2. **Provider hosted authentication**: browser follows provider redirect and user completes provider-managed sign-in. Require provider-side verified email before allowing a new account/invite redemption that depends on email proof. Treat the `email_verified` claim as evidence only if it is present, boolean true, from the configured trusted issuer, and covered by the provider's configured verification policy. Never infer verification because a claim is missing or email looks plausible. Auth0 documents its verification flow; Cognito documents user and federated attribute verification semantics. Recheck exact selected-provider behavior during configuration.
3. **Callback (`GET /auth/callback`)**: validate transaction cookie and state equality in constant time; consume transaction once; reject provider errors, replay, stale transaction, unexpected issuer, missing/invalid code, and callback URI mismatch. Exchange code server-to-server with the same exact redirect URI, verifier and client configuration. Reject non-HTTPS issuer/JWKS endpoints outside test. Validate signature with configured issuer's keys (key rotation/JWKS cache), exact `iss`, intended `aud`/client ID and `azp` where applicable, `exp`, `iat` skew, nonce equality and required claims. Never trust unverified JWT decoding. Use maintained OIDC protocol support only after dependency review; do not hand-roll JOSE/JWKS validation.
4. **Resolve identity**: lookup exact `(issuer, sub)`. If found, resolve to existing user. If missing, proceed only through an allowed account-creation path: verified, unexpired, single-use invitation for the exact currently verified email, or an explicitly enabled one-time bootstrap path. No self-service unrestricted workspace signup in Phase 1. Create user, identity and any allowed membership transactionally. Use the previously proposed conservative email comparison policy (trim surrounding whitespace and lowercase only); do not rewrite provider-specific plus tags or dots. A mismatch rejects redemption and preserves the invitation for proper address use until expiry/revocation. Re-read/lock invitation and relevant account state within the transaction, consume invitation and create membership atomically.
5. **Issue app session**: rotate/clear any pre-authentication session; generate at least 256 bits of CSPRNG entropy for an opaque cookie; hash token server-side with SHA-256 (high entropy makes password-style slow hashing unnecessary) and insert `app_sessions`. Set cookie only after DB commit. Redirect to a fixed allowed same-origin destination. Never place token or claims in URL, browser storage, analytics or logs.
6. **Request authentication**: read cookie; hash candidate and lookup session with active/non-expired/non-revoked status joined to active user. The principal is created from DB rows, never request headers. Enforce idle and absolute timeout; update `last_seen_at` with a bounded write policy so each request does not create a write hotspot (for example update only after a configured interval). For every protected request, re-check user status and workspace/team authorization from current DB state.
7. **Logout (`POST /auth/logout`)**: require CSRF/origin protection, mark the current DB session revoked, then clear the browser cookie with identical attributes. Return success even if already revoked. Local app logout is authoritative and does not depend on provider availability. Optionally redirect the browser through provider logout after local revocation to clear the provider SSO cookie, but a provider logout error must not restore the app session. Do not claim that local logout invalidates all provider sessions or tokens.

The OAuth authorization code flow with PKCE is explicitly supported by Cognito's documentation; Auth0 documents its authorization code flow and PKCE variant. The application must implement `state`, `nonce`, verifier/challenge and token validation regardless of vendor. These mechanisms mitigate request forgery, replay and intercepted-code misuse; they do not replace same-origin callback validation or secure session handling.

### Cookie and request-forgery rules

- Production cookie name: prefer `__Host-app_session`; set `Secure; HttpOnly; Path=/; SameSite=Lax`, no `Domain`, and `Max-Age` aligned to the rolling idle timeout but never beyond absolute expiry. Require HTTPS in production. Local development may use a non-`__Host-` name only when localhost cookie rules require it; never weaken production config as fallback.
- Keep frontend/API same-origin in the first deployment. Do not enable credentialed cross-origin API access as a convenience. If deployment later requires separate origins, document exact allowlists, credential behavior and CSRF implications first.
- `SameSite=Lax` is defense in depth, not the CSRF policy. Require exact configured `Origin` for unsafe cookie-authenticated requests, reject absent/untrusted origin, and require a synchronizer CSRF token (or a rigorously implemented equivalent) in a custom header for browser mutations. Never derive the allowed origin from the request Host header. Apply the existing `PUBLIC_ORIGIN` rule to login/callback/logout and mutation routes.
- Login callback is a top-level safe GET, but must use one-time state and a short-lived transaction cookie. Do not permit callback replay, open redirects, callback path confusion, arbitrary issuer selection or arbitrary return locations.
- Rotate session after login, reauthentication, account linking and changes that materially increase privilege. Regenerate token, revoke predecessor and set the new cookie only after commit.

## 5. Revocation, expiry and provider outages

### Two distinct revocation layers

1. **Application session revocation** is immediate for app requests: logout, admin disablement, membership removal where policy calls for full sign-out, suspicious activity, account linking/unlinking, or secret reset marks the applicable `app_sessions` row(s) revoked. `Authenticator.authenticate` consults PostgreSQL on each request (or a cache with an explicitly bounded invalidation delay; first release should not cache session validity). This supports immediate server-side revocation without provider API calls.
2. **Provider session/token revocation** is separate. Auth0 documents refresh-token revocation; Cognito documents revoking refresh-token descendants and global sign-out. Provider access tokens may remain usable by external resource servers until expiry or checks supported by that provider. Never present provider logout as a guarantee of immediate app-session invalidation, and never use provider JWT signature/expiry-only validation as a substitute for local app-session lookup. Cognito specifically documents that revoked JWTs can still pass a local signature-and-expiration-only verifier.

In Phase 1, do not store provider refresh tokens because the app does not need background calls on behalf of the user. If future integration needs them, make that a separate decision with encrypted-at-rest storage, rotation, revocation and deletion contracts. To reduce the interval in which a remote provider account disablement is not known to this app, enforce a finite absolute app-session lifetime, maintain a local `users.status`, and revoke local sessions when admins disable a user. A provider-side disablement cannot be promised to revoke an already issued app session immediately without provider event delivery or online checks; evaluate back-channel logout/events or bounded online checks as a later requirement. Do not represent app-session expiry as provider revocation.

Set proposed initial limits only after agreeing usability/security requirements: e.g. 30-minute idle timeout and 12-hour absolute lifetime are starting points for review, not selected values. Store timestamps as UTC; expire and prune using an indexed bounded batch job. Also set transaction-cookie expiry (about 5–10 minutes), authorization-code one-time use and rate limits for login/callback. Avoid sliding absolute expiry.

### Provider outage behavior

- Login initiation may fail with a clear retryable `503` if discovery/authorization config is unavailable; do not issue an unauthenticated fallback session.
- Callback token exchange/JWKS validation failures fail closed. Do not create identities or sessions from an unverified callback. Return a safe error/correlation ID, retaining no authorization code or token in logs.
- Existing application sessions continue to work while provider is unreachable if their local session and user remain valid and unexpired. Normal protected requests do not require a provider network round-trip. This is an intentional availability boundary and means external provider revocation has no instantaneous effect on already issued local sessions.
- Logout always revokes the local app session and clears the cookie before attempting optional provider logout. Provider outage must not block local logout.
- If PostgreSQL/session lookup is unavailable, protected requests fail closed with `503` (not `401`, to avoid telling a valid user to reauthenticate during a DB outage). Readiness reports the DB dependency accurately. Public health remains non-sensitive.
- Never silently accept stale cached provider keys after an unknown key ID, issuer change or failed validation. Use a bounded, safe JWKS refresh strategy and fail closed if key refresh cannot establish a trusted signature.

## 6. Account linking, duplicate identity and recovery

Do not merge accounts on matching email, even if both claims say verified. Addresses can be reassigned and identity providers can have different verification histories. Initial safe behavior: a new `(issuer, sub)` with an email already used by an existing app user is **not auto-linked**; block account creation and direct the user to authenticate into the existing account and initiate an explicit link flow, or to a reviewed recovery path.

If linking is required in Phase 1, implement it only as a deliberate authenticated operation: require a recent reauthentication to the current account; start a new provider authorization transaction with state/nonce/PKCE bound to the existing internal user and intent; require provider authentication; verify any required email; confirm in the original authenticated context; insert identity under unique `(issuer, subject)`; prevent identity already linked elsewhere; audit actor/time/result without storing secrets; rotate app session; provide unlinking only if at least one usable sign-in method remains and no workspace access policy is bypassed. Never accept an admin-supplied subject/email link without an audited recovery procedure. If product does not need multiple IdPs at beta, keep linking unavailable and treat collision as a support-recovery case with documented manual verification.

Auth0 supports user profile linking, but application account linking must still preserve the internal-user and authorization model. Cognito can federate upstream OIDC providers, but the app should persist the Cognito issuer/subject as the login identity if Cognito is selected; upstream identity remapping is not a reason to key records on email.

## 7. Bootstrap, invitation and membership dependencies

There must be exactly one reviewed first-workspace/owner bootstrap mechanism. Proposed safest launch behavior: a single-use, high-entropy bootstrap secret supplied out-of-band through deployment secret management, accepted only when the database contains no workspaces and bootstrap is explicitly enabled; exchange it only after successful verified provider login, consume atomically, immediately disable the bootstrap setting and secret, and emit a redacted audit event. Alternative: operator-created initial owner through a documented CLI using a verified provider `(issuer, subject)` mapping. Choose one before exposing workspace creation. Do not derive bootstrap from “first user to sign up” without the one-time gate; public races could seize ownership.

Dependencies before invitation redemption can be enabled end-to-end:

1. Establish verified provider identity and profile/email evidence.
2. Define exact email comparison/canonicalization; invitations must target one exact intended verified address. Do not use domain-only membership or infer Gmail alias equivalence.
3. Define who can invite which role, prevent owner invitation by ordinary admin unless intended, require workspace context, authorize and rate-limit creation/revocation, and define notification delivery/expiry.
4. Redeem atomically: lock invitation and target membership/user rows; check unused, unrevoked, unexpired, exact workspace and role; check verified address; create or resolve internal user and membership; consume invite in the same transaction. Concurrent redemption yields exactly one success. A failed verified-email match must not consume the invite unless abuse policy deliberately chooses that behavior.
5. Re-check membership and team visibility on every request; revocation/removal is effective immediately for authorization. Decide whether membership removal also revokes all the user's sessions or only removes that workspace's access. Recommended default: remove workspace access immediately but preserve sessions for other workspaces; disabling the user revokes every session.

Current repository already contains invitation hash/expiry/redeemed/revoked columns and an implemented redemption persistence seam, but the provider principal, invite issuer policy and complete flow are not present. Validate the current migration and service semantics before building on them; do not repeat claim of completion without an integrated route-level test.

## 8. No-credential and privacy rules

- Never log passwords, raw session cookies, session hashes, authorization codes, state/nonce/verifier, ID/access/refresh tokens, callback query strings, invitation tokens or provider client secrets. Disable query-string capture for auth routes at proxy/APM layers or scrub parameters before logging.
- Do not put tokens/PII in exception messages, request URLs, analytics, frontend error reports or test snapshots. Log request/correlation ID, route category, safe failure class, internal session/user ID only when justified and access-controlled, provider name and timing. Avoid email as routine log context.
- Use secret manager/environment injection for client secret and cookie/session pepper if one is adopted. Do not add secret values to `.env.example`, Docker build args, images, Git, or browser-exposed Vite variables. Rotate credentials and separate development/staging/production tenants or app clients.
- Store a plain SHA-256 digest of the 256-bit random cookie token, not the cookie itself; use constant-time comparison where comparing direct digests, parameterized SQL and no token search endpoint. Pepper/HMAC is an optional defense if its rotation plan is specified; do not create an unrotatable global secret just to hash random entropy.
- Minimize and bound profile data. Define retention/deletion for disabled accounts and audit records with product/legal owners; workspace foreign keys and ownership transfer constrain deletion. Do not log full identity tokens to debug claim mapping.

## 9. Database migration and rollback plan

No schema migration is included in this planning task. Use versioned Prisma migrations as the schema source of truth. The eventual schema change must be additive first and deployable with old code still running:

1. **Inventory**: before migration, count users, inspect whether any `provider_subject` is populated, identify whether it can be reliably mapped to a known issuer/config and whether existing email verification evidence is trustworthy. Do not assume the dev DB is empty or that an undocumented subject is Auth0/Cognito. Back up and validate restore for persistent environments.
2. **Expand**: add the Prisma models and a new Prisma migration for `user_identities`, `app_sessions`, indexes/checks, and user status if selected; initially keep legacy `provider_subject` nullable/readable. Use a reviewed custom SQL migration for constraints/indexes not represented by Prisma schema. If existing rows can be unambiguously mapped, backfill `(issuer, subject)` from evidence and verify row counts/uniqueness. If ambiguous, stop and resolve records; never synthesize identity from email. New app code can dual-write legacy provider_subject only during a short compatibility window if there is a deployed reader that needs it.
3. **Deploy compatible code**: authenticator reads `app_sessions` and user identity; callback upserts `user_identities`; keep legacy reads for old binary compatibility only if needed. Use feature flag/config to keep login disabled until provider setup and schema readiness checks pass. Preserve fail-closed behavior on incomplete config.
4. **Verify and contract**: inspect counts, duplicate keys, dangling users, constraints and session lookup latency. After all deployed processes read the new model and migration window closes, remove `provider_subject` in a later Prisma migration; do not combine destructive contract with expand if rollback may be needed.
5. **Session retention**: cookies do not exist before implementation; during the first real rollout, treat migration/provider switch as a forced reauthentication event. Do not convert provider JWTs into app sessions. Revocation/cleanup migrations must be restart-safe and bounded.

Rollback: before contract migration, disable login feature flag, stop callback issuance and deploy old fail-closed code; additive tables can remain without effect. If authentication behavior is faulty, revoke all newly issued app sessions, clear cookies on next response/login and restore the previous application image. Do not drop identity/session data as rollback. After legacy column removal, rollback requires a forward-compatible recovery migration or restoring the pre-contract backup; document and rehearse before contracting. Avoid rolling back database schema beneath code that requires the new tables. If an issuer/key/config is compromised, disable login, revoke local sessions for affected identities, rotate provider credentials/keys per provider procedures, and require clean reauthentication.

Migration acceptance includes actual upgrade from a copy of the pre-change schema, repeated migration idempotence as supported by the runner, old/new code compatibility for the expand window, no identity collisions, FK behavior, backup/restore evidence, and rollback rehearsal in a non-production environment. Production data restoration is a separately authorized operational procedure; this plan does not perform it.

## 10. Incremental implementation slices and TDD contracts

Follow the repository Phase 1 execution constraints: Node 24 API, Bun workspace manager, PostgreSQL, Docker-only dependency install/checks, isolated test DB, no production credentials, and no claim of green tests until actually observed. The test design below is proposed. Implement through observable contracts with failing tests first; record the real RED failure and GREEN command/result for each slice. Do not add/run tests during this planning-only task.

Any Express, Prisma, OIDC or cookie package change requires the repository dependency-safety gate before the plan can be considered complete or a change committed: inspect supported versions and provenance, run frozen install/audit/typecheck/tests/build in Docker, and review the final manifest/lock diff. Do not install packages or create provider accounts as part of this plan.

### Slice 0 — Migrate the scaffold to the chosen stack

- Move the existing API composition and HTTP seams from Fastify to Express while preserving health/readiness, exact origin handling, fail-closed authentication, safe error mapping and currently implemented workspace/invitation behavior. Replace SQL repository/migration composition with Prisma repositories, one injected Prisma client and versioned Prisma migrations. Keep PostgreSQL and the current data model semantics.
- Before replacing the old migration runner, baseline the existing schema in Prisma's migration history without replaying destructive DDL against an initialized database. Prove a clean database can be created from Prisma migrations and an existing migrated database can be adopted without losing workspace, team, membership or invitation data. Retain a tested recovery path for any mismatch.
- Add the Express request principal typing and route tests at the public HTTP boundary. Verify the same anonymous 401, origin rejection, health/readiness and fail-closed production startup contracts as the current API. Do not enable login in this slice.
- Completion requires parity evidence and a rehearsed schema adoption/rollback path; do not combine this runtime change with provider login so regressions have a clear boundary.

### Slice A — Provider-neutral identity/session schema

- Add additive migration for identities, app sessions and selected user status; migration/backfill strategy above.
- TDD at Prisma/PostgreSQL integration boundary: unique `(issuer, subject)` rejects duplicate mapping; same subject across different issuers is allowed; user deletion cascades only according to reviewed policy; session hash unique; revoked/expired state is queryable; identity cannot point to missing user; migration preserves existing workspace memberships and invitation references.
- Include concurrency test for two first-login attempts of the same identity: exactly one user/identity mapping survives and both requests resolve to the same internal user or one receives a controlled retryable conflict.

### Slice B — OIDC transaction and provider adapter

- Define narrow interfaces in `apps/api/src/auth`: `IdentityProvider` builds authorization URL and exchanges callback; `OidcVerifier` returns typed validated claims; `LoginTransactionStore` creates/consumes one-time transaction; `IdentityRepository` resolves/upserts `(issuer, sub)`; `SessionRepository` creates/revokes/looks up app sessions. Composition root supplies real provider adapter and configuration; feature/application code does not import provider SDK or read environment directly.
- Choose and review a maintained OIDC library/dependency before adding it; dependency change invokes the repo dependency safety gate. Do not write a custom JWT verifier. Client secret is server-only.
- Test contracts with deterministic fake issuer/JWKS and provider adapter plus a small isolated test provider only if library behavior needs a protocol-level verification. Assert state, nonce and PKCE are fresh, challenge is S256, callbacks are single-use, wrong state/nonce/issuer/audience/signature/expired token/wrong redirect/provider error all fail without user/session writes; key rotation and unknown key failure are handled safely. Avoid brittle tests that assert internal helper names.
- Add production startup checks that require issuer, client ID/secret (if confidential client), exact callback URI, cookie settings and trusted origin; malformed config fails before listening. Continue fail closed when incomplete.

### Slice C — App-owned session and cookie authentication

- Implement CSPRNG token issue/hash, session insert/lookup/revoke, cookie serialization/clear and `Authenticator`. Only verified provider claims resolve to a `Principal`; every request checks local session state and active user. Avoid storing provider tokens.
- API tests: no cookie -> `401`; malformed/unknown/hash-mismatch -> `401`; active session -> principal resolved from DB; expired idle/absolute, revoked session, disabled user -> `401`; database failure -> `503`; cookie is HttpOnly/Secure/SameSite/Path-correct, no Domain, production HTTPS required; login rotates preexisting cookie; session raw value never appears in database/log capture; disabling a user revokes all sessions.
- Integration tests against PostgreSQL through the Prisma repository prove immediate revoke on the next request using the same connection pool; expiry boundaries use an injected clock, not sleeps.

### Slice D — Browser login, callback, logout and CSRF

- Add `/auth/login`, `/auth/callback`, `/auth/logout` with same-origin post-login path allowlist, provider errors and safe UI result states. Ensure mutation origin checks remain centralized and CSRF token verified on logout and other cookie-auth mutations.
- Contract tests: no open redirect for absolute, protocol-relative, encoded or hostile path; callback state cookie binds transaction; replay works once only; logout clears cookie and revokes locally even when provider logout endpoint is unavailable; cross-origin/missing Origin/CSRF rejected; unauthenticated logout behavior is idempotent; redirects never contain secrets. Capture structured logs in tests and assert all auth secrets are redacted.
- UI flow tests only after real endpoint contract exists: login button begins redirect, callback errors are safe and accessible, expired session returns to login with a return path, no token reaches localStorage/sessionStorage, disabled/unavailable states are truthful.

### Slice E — Provisioning, bootstrap and invitations

- Complete bootstrap policy and role permission matrix before endpoint activation. Add verified-identity account creation only for invitation or one-time bootstrap. Define how unverified and changed email is handled. Wire invitation issuance/revocation policy before exposing redemption.
- Contract and DB tests: only verified invite address redeems, mismatched email fails without membership, expired/revoked/redeemed invite fails, concurrent redemption yields one membership and one consumed invite, role cannot be elevated by request tampering, bootstrap only succeeds once on empty workspace set and then is unusable, regular users cannot claim ownership, replay cannot create duplicate memberships. Transaction rollback leaves no partial user/membership/invite state.

### Slice F — Authorization, outage and operations integration

- Re-check existing workspace list/redeem service with new principal; define full role/team policy; ensure every protected route, subscription and delivery path uses current membership and private-team visibility checks. Define account disable/removal consequences and owner succession.
- Tests: two workspaces and multiple users/roles; guessed IDs cannot read or mutate; removed membership loses that workspace immediately but retains another if policy says so; owner/admin/member route matrix; private-team policy; pool reuse does not leak transaction or RLS context if RLS chosen; provider outage leaves an existing local session working but login/callback fails closed; DB outage denies protected requests; local logout succeeds during provider outage.
- Operational acceptance: health/readiness accurately separates API liveness, DB readiness and provider login dependency; metrics count safe outcome classes without token/email; rate limits protect login, callback and invitation endpoints; session cleanup bounded and monitored; backup/restore, secret rotation, alert owner and incident procedure documented.

### Slice G — Provider-specific acceptance and handoff

- Configure an isolated development/staging provider tenant/pool and exact callback/logout/origin allowlists only after provider selection. Exercise email verification, recovery, account linking decision, IdP outage, key rotation and sign-out semantics against provider sandbox. No external account is created as part of this plan.
- Document provider export/termination approach, issuer value, JWKS/discovery behavior, webhook/back-channel limitations, tier/region/MAU assumptions, cost, tenant separation and emergency disable procedure.
- Phase 1 identity exit requires the full test suite and accepted role/bootstrap/invitation decisions; observed provider login/logout and DB revocation in staging; migration/rollback evidence; security/log review; and explicit residual risks. Passing unit tests alone is insufficient.

## 11. Provider comparison to carry into selection

| Concern | Auth0 candidate | Cognito alternative | Decision implication |
| --- | --- | --- | --- |
| Hosted login and OIDC | Universal Login is a hosted authorization-server login flow; Auth0 docs cover Authorization Code and PKCE. | Cognito `/oauth2/authorize` directs to managed login or an upstream IdP; docs cover PKCE and optional `state`/`nonce`. | Both can support the intended hosted OIDC redirect design; verify exact tenant/pool settings and callbacks in a non-production environment. |
| Verified email | Auth0 supports verification email workflows and `email_verified`; provider policy/config must ensure required verification. | User pools support email verification; federated mapped email may be unverified unless verification claim is mapped. | Require validated boolean verification evidence; test signup, recovery and email change behavior. |
| Session revocation | Refresh token revocation is documented, but this app will rely on local DB sessions for request-time app authorization. | Refresh-token revocation/global sign-out are documented; AWS warns local JWT signature/expiry validation can still accept revoked JWTs. | Local app sessions are required with either vendor; provider logout is not the app-session revocation mechanism. |
| Cost | Public pricing currently shows Free up to 25K MAU and paid tiers, but B2B features, domain and plan selection can change actual price. | MAU/tier pricing with free-tier eligibility nuances, plus possible advanced-security, SMS/email, regional and other charges. | Model actual expected MAU/features/region; do not choose from the headline free tier. |
| Region/residency | Region/deployment model and tenant options need confirmation against required residency. | AWS region choice and dependent email/SMS, replication and service availability need confirmation. | Region and legal/data-residency requirements remain open. |
| Portability | Standard OIDC pair can be retained; Auth0 management/user export exists but provider-specific profile features may need mapping. | Standard OIDC issuer/subject plus Cognito profile mapping can be retained; AWS-specific claims and user-pool semantics need mapping. | Keep provider adapter small and store issuer/subject; do not promise one-click migration or seamless cross-provider subject continuity. |

## 12. Security review checklist and unresolved risks

The implementation review should verify these controls against concrete code/config and tests:

- OIDC discovery/JWKS trust is pinned to configured issuer; HTTPS enforced; `state`, `nonce`, PKCE S256, audience, signature, expiry, issuer and redirect URI checked; code/transaction are single use; no arbitrary issuer or redirect.
- External identity key is `(iss, sub)` only; no email auto-link; verified claim semantics and changed-email handling are documented; unverified users cannot redeem invitations or bootstrap.
- Application session cookie is opaque, random, hashed at rest, HttpOnly, Secure in production, SameSite, host-only, bounded idle/absolute TTL, rotated on auth/privilege transition, and looked up/revoked server-side on every protected request.
- User disablement, session revocation, membership removal, private-team denial, invitation redemption and owner transfer are checked on server and in SQL/transaction boundaries; tenant-owned foreign keys and any RLS defense in depth are tested with real pooled connections.
- Cookie-authenticated writes enforce exact origin and CSRF token; `PUBLIC_ORIGIN` is not derived from Host; rate limits and safe error mapping are present.
- Logs/APM/proxy/browser analytics redact all credentials/tokens/transaction secrets; secrets are server-side; no auth tokens in browser storage; retention and support access are bounded.
- Provider outage behavior matches this plan. Local DB lookup availability is monitored; revocation is not cached without a measured invalidation contract; provider revocation limitations and session TTL are disclosed to product/security owners.
- Provider tier, region/residency, support/SLA and cost are verified from current official pricing/contract pages at selection time. Free tier eligibility is not assumed.

Unresolved security/product decisions: whether every login requires verified email; acceptable session timeout and reauthentication intervals; whether external enterprise IdP is beta scope; whether account linking is needed or deferred; whether disabled/deleted users retain audit history; membership removal effects on sessions; exact invitation email equality policy; bootstrap owner workflow; data residency; and local account recovery/support process. Resolve these before production configuration, not by relaxing callback checks or auto-linking on email.

## 13. Sources checked

Provider and protocol claims in this plan are grounded in these primary sources (checked 14 November 2026):

- Auth0: [Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login), [Authorization Code Flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow), [Verify Emails](https://auth0.com/docs/manage-users/user-accounts/verify-emails), [Revoke Refresh Tokens](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens), [Pricing](https://auth0.com/pricing).
- Amazon Cognito: [Authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [PKCE in authorization-code grants](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), [email/phone verification](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-email-phone-verification.html), [token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html), [pricing](https://aws.amazon.com/cognito/pricing/), [FAQ](https://aws.amazon.com/cognito/faqs/).
- Protocol: [OpenID Connect Core 1.0, Claim Stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).

Provider pages are live and pricing can change; re-open the selected plan and region pricing immediately before vendor selection. These sources document provider capabilities, not a configured service, a local implementation, an SLA applicable to this project, or a verified production setup.
