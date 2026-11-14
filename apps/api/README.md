# API foundation

Run the API with Node 24 through the repository's Docker workflow. The API uses Express 5, Prisma ORM 7, PostgreSQL, and the `pg` driver adapter. Generate Prisma Client with `bun run prisma:generate` before typechecking or building; the generated source lives under `src/generated/prisma`. Useful scripts are `dev`, `prisma:generate`, `prisma:validate`, `build`, `start`, `migrate`, `migrate:baseline:check`, `migrate:baseline:mark`, `test`, `test:integration`, and `typecheck`.

`migrate` runs `prisma migrate deploy`. Use it against an empty disposable database or one whose Prisma history is already initialized. It never resets a database. Do not use `prisma migrate dev` or `migrate reset` against development data.

## Existing development database

The existing Compose development database has the original SQL schema and legacy `schema_migrations` marker. Its initial Prisma migration is a baseline that recreates that schema on an empty database. Before the existing database can use ordinary Prisma migrations, its schema must be verified and the baseline marked as already applied; do not run `migrate` first, because it would try to create existing tables.

The explicit baseline check is limited to the Compose development endpoint `db:5432`, database `ticketing`, role `ticketing`. It requires `BASELINE_DATABASE_URL` and `DATABASE_URL` to be identical, rejects production mode and test-target matches, verifies the exact old ledger row, compares the database against the immutable `prisma/baseline/schema.prisma` snapshot, and checks SQL-only constraints and indexes against temporary definitions. The snapshot must remain at the pre-additive-migrations schema so later app-session models in the main schema do not make the old development baseline appear drifted. Temporary verification DDL runs in a transaction that is rolled back. The mark command repeats the checks, then runs `prisma migrate resolve --applied 20261114000000_identity_workspaces_baseline`; it does not recreate or drop application tables or change existing rows. After marking, apply any later additive migrations with ordinary `prisma migrate deploy`.

Run these commands only inside Docker with the development target explicitly configured:

```sh
BASELINE_DATABASE_URL="$DATABASE_URL" bun run migrate:baseline:check
BASELINE_DATABASE_URL="$DATABASE_URL" bun run migrate:baseline:mark
```

If either guard reports a difference, stop. Do not override the result; compare the live schema and reviewed `001_identity_workspaces.sql` / Prisma baseline, then prepare a reviewed forward migration or repair plan. The baseline check is not a substitute for a backup or a schema review.

## HTTP and security boundaries

`GET /api/v1/health` is process-only; `GET /api/v1/ready` checks PostgreSQL. Each response carries a validated incoming request ID or a generated UUID. Protected requests fail closed while no provider is configured; production startup refuses that configuration. Identity is never accepted from user-controlled headers or body fields. The in-progress implementation includes hosted OIDC sign-in, app-owned sessions, logout, invitation administration, and authorization policies; these changes have not yet passed the full Docker verification.

`PUBLIC_ORIGIN` is required and must be an exact HTTP or HTTPS origin. Unsafe authenticated requests reject a missing or different `Origin`, independent of Host and forwarded headers. Production requires HTTPS. `TRUST_PROXY` defaults to false and production refuses enabling it until a bounded proxy allowlist is implemented.

## Integration tests

Integration tests require `TEST_DATABASE_URL` and accept only the Compose service host `db-test` on port 5432, database `ticketing_test`, and role `ticketing_test` (hostname comparison is case-insensitive). The guard rejects a target matching `DATABASE_URL` by host, effective port, and database name even when credentials differ. The suite applies migrations with Prisma `migrate deploy` to this explicitly allowed disposable target, then uses direct PostgreSQL constraint checks and Prisma transaction tests. It never resets or falls back to development or production data.

Workspace listing, team visibility, invitation lifecycle, role changes, ownership transfer, and persistent rate limiting are implemented in the current worktree but remain unverified. Staging and production deployment, provider credentials, retention and operational policies remain outstanding. This is a partial Phase 1 foundation, not a complete ticketing system.
