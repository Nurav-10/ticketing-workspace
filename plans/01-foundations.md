# Phase 1 — Foundations, identity and workspace isolation

**Goal:** a runnable, deployable skeleton with trustworthy identity and workspace boundaries. Depends on Phase 0.

## 1.1 Workspace and runtime

- Create Bun workspaces for web, API, worker and shared contracts. Use strict TypeScript, a formatter/linter, committed lockfile and documented scripts. Run the API on a supported Node LTS. Keep secrets out of the browser bundle.
- Set up local PostgreSQL, environment validation, migrations and isolated test databases. Provide Docker Compose for PostgreSQL and a documented alternative for users without Docker.
- Add CI for clean install, static checks, build, migrations and relevant tests. Select exact versions only after vulnerability, license, resolution and runtime review; follow the dependency-safety gate.

## 1.2 Identity and sessions

- Choose a managed identity provider after assessing cost, region, account recovery, verified email, security and portability. Encapsulate it behind an adapter; use hosted flows initially.
- Implement login, logout, session expiry/revocation and account linking only for verified identities. Use HttpOnly, Secure, appropriate SameSite cookies. Prefer a same-origin app/API deployment and enforce CSRF/origin protections for unsafe cookie-authenticated requests.
- Do not store bearer credentials in browser local storage. Define behavior for expired sessions, revoked membership and concurrent logins.

## 1.3 Workspaces, teams and authorization

- Model users, workspaces, workspace memberships, teams and team memberships with foreign keys, uniqueness constraints and timestamps. Initial workspace roles: owner, admin and member. Teams are workspace-visible or private; define precise admin and private-team access rules before coding. Guests and custom roles are deferred.
- Implement authorized invitations with expiry, single-use redemption and revocation; only the invited verified address can redeem. Redemption and membership creation are atomic.
- Every resource query is workspace-scoped; private-team access is checked for every read, write, subscription and delivery. Database constraints prevent cross-tenant relationships.
- If using row-level security, use a non-owner/non-BYPASSRLS runtime role, transaction-scoped context and tests with the actual connection pool. RLS is defense in depth alongside application authorization.

## 1.4 API and operations baseline

Define versioned routes, validated input, bounded pagination, request IDs, OpenAPI and consistent errors: 400 invalid, 401 unauthenticated, 403/404 per disclosure policy, 409 conflict and 429 rate limit. Redact credentials and sensitive content from logs. Add health/readiness endpoints, metrics, automated migrations and a first staging deployment.

**Acceptance / exit:** clean startup, migrations, CI and staging deployment work; invitations cannot be replayed; removed users lose access; owner/admin/member actions match the agreed matrix; cross-workspace and private-team access fails even when IDs are guessed. Verify with two workspaces, multiple roles, pooled DB connections and reconnects. Document schema and application rollback.
