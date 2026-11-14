# Express and Prisma backend migration

Status: implementation in progress · 14 November 2026

## Outcome

Replace the API transport and persistence implementation with Express 5 and Prisma ORM 7 / Prisma Migrate while preserving the current API contract and every existing database invariant. Keep the current Node 24 runtime, Bun workspace workflow, PostgreSQL 16 Compose services, and strict TypeScript setup.

Selected maintained versions, checked against official project documentation on 14 November 2026:

- `express` 5.3.0, the current Express 5 release line.
- `prisma`, `@prisma/client`, and `@prisma/adapter-pg` 7.10.1, the current generally available Prisma ORM line. Prisma ORM 8 is still a release candidate, so it is excluded.
- Preserve `pg` explicitly if needed by the adapter peer dependency and by integration tests that independently exercise PostgreSQL constraint codes; verify the official package manifest/resolution before finalizing.

The dependency set is provisional until it passes the repository's Dependency Safety Gate. Root `package.json`, `bun.lock`, `Dockerfile`, and `compose.yaml` are parent-owned; communicate required changes and exact package pins before lockfile/container edits.

## Existing behavior and invariants to preserve

- `GET /api/v1/health` is process-only and succeeds without database access. `GET /api/v1/ready` checks PostgreSQL and returns 503 when it is unavailable.
- All responses carry a validated incoming `x-request-id` or a generated UUID in the response header. Error bodies keep `{ error: { code, message, requestId? } }`; unknown errors are logged and become generic `internal_error` responses.
- Health and OpenAPI routes remain public. Protected routes authenticate first through the injected provider adapter. The default adapter remains fail-closed; no request header, body field, query parameter, or cookie is treated as an identity claim. Production refuses an unconfigured authenticator.
- Unsafe authenticated requests require exact `Origin === PUBLIC_ORIGIN`; Host and forwarded headers do not affect this check. Production requires HTTPS origin and refuses unrestricted proxy trust.
- Tenant isolation remains enforced in queries and database foreign keys. Workspace listing is scoped to the verified internal user. Team membership composite foreign keys retain workspace locality.
- Invitation redemption remains single-use and atomic: lock the selected invitation and target user in one transaction, validate active/unexpired invitation and verified normalized email, insert one workspace membership, then mark redeemed. Concurrent redemption has one winner; the loser receives the established unavailable/already-member conflict behavior without a partial write.
- Keep all SQL checks, partial uniqueness, composite foreign keys, defaults, cascade behavior, and indexes. Prisma's model alone is not treated as the full database contract.
- Never reset, drop, or recreate the existing development database or its named volume.

## Implementation slices

### 1. Establish the Prisma contract and safe migration history

- Add a Prisma 7 schema representing all existing tables, columns, scalar types, defaults, unique constraints, relations, and indexes, using explicit `@map`/`@@map` for current snake_case names.
- Represent UUID, `bytea`, timestamp-with-time-zone, enum-like text fields, and PostgreSQL naming precisely. Preserve enum-like `CHECK` constraints and other unsupported native rules with reviewed SQL in the migration history.
- Create a reviewed initial baseline SQL migration matching `001_identity_workspaces.sql`; retain SQL for `pgcrypto`, nonempty/format checks, role and visibility checks, the invitation single-use condition, and `workspace_single_owner` partial unique index. Keep the composite workspace/team and workspace/membership foreign keys explicitly represented or preserved in SQL.
- Configure Prisma 7 with `prisma.config.ts`, PostgreSQL datasource URL from `DATABASE_URL`, a generated client output inside `apps/api`, and a PostgreSQL driver adapter.
- Add an explicit baseline command/procedure that compares against an immutable `prisma/baseline/schema.prisma` snapshot and runs only after a read-only schema equivalence check confirms the target already matches that initial baseline. Later additive models and migrations must not alter this snapshot. It must mark the baseline as applied through Prisma Migrate without applying DDL to the existing database. No startup auto-baselining and no `migrate reset` command. After the old database baseline is marked, ordinary `migrate deploy` applies later additive migrations.
- A separate disposable test database starts empty and uses `prisma migrate deploy`; the application and tests never infer permission to reset an existing target from its name.

**Exit evidence:** Prisma schema validates and client generates in Docker; a schema comparison checklist covers every live SQL object; baseline procedure is a separate, explicit command with a documented target guard; fresh disposable database deploys the migration history.

### 2. Replace SQL repositories with Prisma-backed repositories

- Introduce one Prisma client factory using `PrismaPg` and configured pool bounds; readiness probes use a minimal query and remain separate from process health.
- Convert workspace listing to a relation query filtered by verified `userId`, with stable ordering and a narrow response projection.
- Convert invitation redemption to an interactive transaction. Use parameterized PostgreSQL `SELECT ... FOR UPDATE` statements for invitation and user rows in deterministic order, then use Prisma for typed state reads/writes and membership creation. Keep all validation and mutations within the same transaction.
- Ensure row locks cover both invite and user. A missing user or invite fails closed. Preserve membership uniqueness behavior and translate known Prisma/PostgreSQL unique conflicts to the established API error codes. Unknown storage failures remain generic server errors.
- Remove old raw `pg` repository and custom SQL migration runner once integration seams and startup paths have moved; retain `pg` if Prisma adapter or independently scoped integration checks require it.

**Exit evidence:** repository tests cover user-scoped workspace query, all redemption guards, atomic rollback, simultaneous redemption with exactly one success, and database uniqueness/foreign key behavior.

### 3. Move the HTTP boundary from Fastify to Express 5

- Rebuild `buildApp` around an Express application with dependency injection for configuration, authenticator, readiness probe, workspace service, and invitation service.
- Add middleware in an explicit order: request ID and response header, bounded JSON body parser, public health/OpenAPI routes, authentication and Origin checks for protected routers, not-found handler, then centralized error handler.
- Adapt authenticator request typing to Express without expanding trusted identity inputs. Keep auth and unsafe-Origin policy in a framework-neutral boundary where practical.
- Preserve exact endpoint paths, methods, body validation, success payload envelopes, request ID header/body conventions, and status/error codes. Add asynchronous route wrappers or Express 5 async handling with proper typed error forwarding.
- Keep health independent of Prisma; readiness alone accesses the DB. Restrict body parsing to JSON and define reasonable payload limits.

**Exit evidence:** tests start the actual app on an ephemeral localhost port and use Node's `fetch`; they exercise HTTP status, headers, cookies/Origin behavior, JSON validation, public health behavior, error shape, and route response envelopes.

### 4. Replace integration setup and protect the dev database

- Update the integration target guard to accept only the Compose test service host `db-test`, port 5432, database `ticketing_test`, and role `ticketing_test`; reject production mode and any URL matching `DATABASE_URL` by host/effective port/database, regardless of credentials.
- Before migration, verify the target is a disposable test target under the strict allowlist. Use `prisma migrate deploy`, never `migrate dev` or reset, in test setup.
- Keep integration data isolated by unique IDs and explicit cleanup. Constraint probes use direct `pg` where useful so their evidence is independent of Prisma behavior.
- Ensure no script runs baseline resolution against `DATABASE_URL` implicitly; baseline commands require an explicit opt-in and a separate exact-target guard/documented operator procedure.

**Exit evidence:** Docker integration harness proves a fresh DB migrates; guard tests reject missing, wrong-host, wrong-role/database, production, and same-as-development targets before a connection or migration is attempted. Existing dev DB remains untouched.

### 5. Runtime packaging and final review

- Update API scripts for Prisma generate/validate/migrate deploy/baseline and Express build/start. Preserve workspace script names expected by Docker Compose.
- Ensure Docker's Node 24 build stage generates Prisma Client before TypeScript compilation and runtime packaging includes generated client, adapter dependencies, schema/migrations/config needed for deploy. Parent owns Docker and compose edits.
- Run dependency verification, typecheck/build, unit tests, HTTP tests, migration integration suite, and production build/start checks only inside the approved Docker workflow. Do not install dependencies or run tests on the host.
- Review the final API diff against every preserved behavior and the reviewed SQL schema. Report any check not run or blocked by Docker.

**Exit evidence:** parent-run frozen Bun install, Docker build, HTTP checks, and fresh disposable database migration/integration checks all pass; the final manifest and lockfile agree and dependency scan has no blocking findings.

## Dependency Safety Gate before commit

Because this migration changes `apps/api/package.json`, completion requires the repository dependency safety workflow against the exact final manifest and lockfile:

1. Reproduce Bun's frozen install in Docker; verify dependency graph and peer/runtime compatibility, including Express types and Prisma adapter `pg` requirements.
2. Audit newly introduced and changed direct/transitive packages for known vulnerabilities using the project's supported scanner. Review the exact package names, versions, provenance, install scripts, and licenses/policy constraints.
3. Run API typecheck, build, unit and actual HTTP tests, and PostgreSQL integration/migration tests in Docker; run production-oriented image build/start validation when supported.
4. Review API manifests and parent-owned root lockfile/container changes together. The result stays not ready if any applicable blocking check fails or remains unknown.

The migration is complete only when the parent confirms Docker checks and dependency verification against the final lockfile. No host installs/tests and no database reset are allowed during this work.

## Exclusions

This migration does not select or implement an identity provider, add cookie issuance/logout, authorize invitation issuance/revocation, add team/private-team policy, or extend product scope. No real auth spoof/test-only production bypass may be introduced.
