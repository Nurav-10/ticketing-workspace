# Phase 1 app session persistence plan

This plan implements the persistence boundary used by `SessionService`. It does not select or implement an OIDC provider, issue cookies, wire the `Authenticator`, or make login available. The bearer value remains an application-owned secret; PostgreSQL receives only its 32-byte SHA-256 digest.

## Target storage shape

Add `AppSession` to `apps/api/prisma/schema.prisma`, mapped to `app_sessions`:

| Field | PostgreSQL type | Constraint / mapping |
| --- | --- | --- |
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `userId` | `UUID` | required FK to `users(id)`, `ON DELETE CASCADE` |
| `tokenHash` | `BYTEA` | required, unique, custom `CHECK (octet_length(token_hash) = 32)` |
| `createdAt` | `TIMESTAMPTZ(6)` | required |
| `lastSeenAt` | `TIMESTAMPTZ(6)` | required |
| `idleExpiresAt` | `TIMESTAMPTZ(6)` | required |
| `absoluteExpiresAt` | `TIMESTAMPTZ(6)` | required |
| `revokedAt` | `TIMESTAMPTZ(6)` | nullable |
| `revokeReason` | `TEXT` | nullable; internal allowlisted reason only, never request text |

Add the relation to `User`, `@@unique([tokenHash])`, `@@index([userId])`, and a custom SQL check that `created_at <= last_seen_at`, both expiries follow creation, and `idle_expires_at <= absolute_expires_at`. Do not add IP address, user-agent, provider-token, or raw bearer columns. The planned identity migration also needs a local `users.status` field (at minimum `active` / `disabled`) because session authentication must join and reject inactive users; choose its exact SQL/model representation with the identity migration owner.

The session service passes durations, not wall-clock timestamps. The adapter computes creation and expiry values from one database `clock_timestamp()` sample. Authentication first locks the session row, then samples the database clock and checks revocation, idle expiry, absolute expiry, and current user status in one query. Idle refresh occurs only when `last_seen_at` is at or older than the configured touch interval, and is capped at absolute expiry. Expiry is exclusive: a row is invalid when `expires_at <= now`. Logout updates `revoked_at` with database time and is idempotent. Session lookups remain uncached.

Use additive migration `002_app_sessions.sql` after the existing `001_identity_workspaces.sql` baseline. If the identity migration owner has already assigned `002` to the identity model change, split the identity/status and session DDL into ordered, additive migrations and update the generated Prisma history; do not reuse a migration name or edit an applied migration. The session portion should be equivalent to:

```sql
ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'));

CREATE TABLE app_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT app_sessions_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT app_sessions_lifecycle CHECK (
    created_at <= last_seen_at
    AND created_at < idle_expires_at
    AND created_at < absolute_expires_at
    AND idle_expires_at <= absolute_expires_at
  )
);
CREATE INDEX app_sessions_user_id_idx ON app_sessions(user_id);
CREATE INDEX app_sessions_expiry_cleanup_idx ON app_sessions(idle_expires_at)
  WHERE revoked_at IS NULL;
```

The actual Prisma migration should preserve the repository's existing naming and formatting conventions. Add `status String @default("active") @map("status")` on `User` and the `AppSession` model with UUID, Bytes, and `@db.Timestamptz(6)` fields. Keep the check constraints and partial cleanup index as reviewed custom SQL in the migration because Prisma schema cannot express all of them.

## Adapter status and integration

`apps/api/src/sessions/prisma-session-repository.ts` is written against the planned `app_sessions` table and `users.status = 'active'`, using Prisma tagged raw SQL for row locking and clock-sensitive operations. It intentionally uses no generated session model, but it cannot work against the current schema until the migration adds both the table and status column. Wire `PrismaSessionRepository` into a future `SessionService`/`Authenticator` composition only after schema generation and DB migration; do not mark provider auth configured based on this adapter alone.

The adapter does not enforce workspace/team membership: every protected request must still perform current membership and resource checks. If a membership or account-status change requires signing out a user, the owning transaction must revoke the policy-selected sessions atomically with the change, or document a clear follow-up. The present service port only revokes by bearer token, so bulk user/session revocation needs an explicitly reviewed repository operation before those flows are implemented.

## Migration and integration sequence

1. Add `users.status` with a safe legacy backfill to `active`, a database constraint/default for new rows, then add `app_sessions`, its user FK, unique hash and lifecycle checks in additive migration `002_app_sessions.sql` (or the next unused sequence if identity work claims 002). Preserve all existing workspace, team, membership, and invitation rows.
2. Generate Prisma client from the schema. Compare the Prisma model with the handwritten SQL target and verify the custom checks/indexes remain in the generated migration. Never apply this migration to a deployed database until the repository's baseline/adoption process has been reviewed.
3. Add a PostgreSQL integration fixture that creates an active user, then issues through `SessionService` + `PrismaSessionRepository`. Query the table directly and assert token hash equality, 32-byte digest length, and absence of raw token material.
4. Use injected controlled DB time or explicit SQL timestamp updates (no sleeps) to verify a session authenticates immediately before each boundary and fails at `idle_expires_at = now` and `absolute_expires_at = now`; verify refreshed idle expiry never exceeds absolute expiry and refresh writes are bounded by `touchIntervalMs`.
5. Verify unknown hash, disabled user, revoked row, idle-expired row, and absolute-expired row all return `null`. Verify database errors propagate so the HTTP boundary can map them to unavailable rather than silently authenticating.
6. With a shared connection pool, issue two concurrent authentication/logout operations. If revoke commits before authentication obtains its row lock, authentication must fail; once revoke returns, the next authentication must fail. Repeat logout and assert the original `revoked_at` is retained. Add a concurrent user-disable/session-create case so a disabled account cannot gain a usable session.
7. Verify unique token hashes, FK cascade policy, deletion policy, transaction rollback, and that no query logging or captured structured logs contain raw tokens or token hashes. Confirm the app invokes request-time membership checks after session authentication.

## Known integration work

- The current schema has no `AppSession` model and no `User.status`; the adapter requires the migration owner to add them.
- The current `Authenticator` comments describe provider verification and `main.ts` still composes the fail-closed adapter. No cookie parsing, cookie set/clear, login, logout route, session adapter wiring, active-user schema support, or provider authentication is claimed by this plan.
- The `SessionRepository` currently offers token-level revocation only. Account disablement, membership-driven revocation, privilege-transition rotation, and session cleanup need policy and repository APIs in the owning slices.
- Expiry values are based on database time. Unit tests use an in-memory repository clock; PostgreSQL integration cases must control DB timestamps or expose a test-only database clock seam rather than use sleeps or rely on host clock synchronization.
