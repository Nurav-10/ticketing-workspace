# Ticketing workspace

A container-first foundation for a multi-workspace issue tracker. The product and phase plans are in [plan.md](plan.md); the active implementation breakdown is in [the Phase 1 blueprint](plans/01-implementation-blueprint.md).

**Backend migration in progress:** the Express and Prisma implementation and the commands below have not yet passed their full Docker verification. Do not reset or delete an existing database volume to make migration commands work; see the [migration plan](plans/01-express-prisma-migration.md).

The current milestone is an in-progress ticketing product. A real identity provider has not been configured; protected endpoints fail closed until authentication is configured. The issue UI supports creation, editing, status changes and archive/restore for an authorized team. Workspace owners and administrators can create teams, manage private-team membership, and issue or revoke pending invitations; invited users can enter an invitation code to join. These flows still require real-provider and browser verification.

## Requirements

- Docker Desktop or Docker Engine with the Compose plugin.
- No host installation of Bun, Node, PostgreSQL or project libraries is needed.

Docker builds the Node/Bun application image and installs locked dependencies within its layers. Source files and the Bun lockfile live in the workspace; project dependencies and generated build output stay in containers. The images are Linux containers.

## Start locally

From this directory:

The migration command below is for a fresh database. An existing database from the earlier SQL migration requires the explicit, guarded baseline procedure in the [API README](apps/api/README.md) before applying Prisma migrations. Do not run baseline or deploy commands against existing data without checking that procedure.

```powershell
docker compose build
docker compose up -d --wait db
docker compose run --rm --no-deps api bun run --filter @ticketing/api migrate
docker compose up -d api web
```

Open http://127.0.0.1:5173. The API is available at http://127.0.0.1:3000/api/v1/health. The database is not published to the host. Compose uses development-only database credentials on its isolated network; never reuse them for a deployed environment.

Images contain a snapshot of the source instead of mounting the workspace. Rebuild and restart a service after changing its code:

```powershell
docker compose up -d --build api web
```

To stop the development services without deleting their database volume:

```powershell
docker compose stop
```

The default browser origin is http://127.0.0.1:5173. An optional local .env file may override PUBLIC_ORIGIN; see [.env.example](.env.example). Use the same browser origin as configured, because authenticated writes will reject a different Origin.

## Container-only checks

Build a clean image and run the workspace checks:

```powershell
docker compose build api
docker compose run --rm --no-deps api bun run typecheck
docker compose run --rm --no-deps api bun run test
docker compose run --rm --no-deps api bun test apps/web/src
docker compose run --rm --no-deps api bun run build
docker compose run --rm --no-deps api bun audit
```

The PostgreSQL integration suite uses a separate disposable test database, never the development database:

```powershell
docker compose --profile test up -d --wait db-test
docker compose --profile test run --rm --no-deps -e TEST_DATABASE_URL=postgres://ticketing_test:local-test-only@db-test:5432/ticketing_test api bun run --filter @ticketing/api test:integration
docker compose --profile test stop db-test
```

The test database uses temporary storage; stopping it discards its data. Do not point TEST_DATABASE_URL at a database containing data you want to retain. The development database uses a named volume and is not deleted by these commands.

To update dependencies, generate the lockfile inside a temporary container, review the resulting manifest and lockfile, rebuild with a frozen install, and run the dependency safety checks. Do not run a package install on the host.

## Security and scope

The default identity boundary is unconfigured and rejects protected operations; production startup is blocked without configured authentication. OIDC sessions, invitation management, and role/team policies are implemented in progress and require Docker and staging verification. Provider credentials, a hosting environment, deployment access controls, and a retention policy are still needed. Development services and credentials are not a production deployment.
