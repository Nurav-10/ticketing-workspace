# Ticketing workspace

A container-first foundation for a multi-workspace issue tracker. The product and phase plans are in [plan.md](plan.md); the active implementation breakdown is in [the Phase 1 blueprint](plans/01-implementation-blueprint.md).

The current milestone is a foundation, not a finished ticketing product. A real identity provider has not been configured. Protected endpoints fail closed, and sign-in, account creation, team management and issue editing are not available yet.

## Requirements

- Docker Desktop or Docker Engine with the Compose plugin.
- No host installation of Bun, Node, PostgreSQL or project libraries is needed.

Docker builds the Node/Bun application image and installs locked dependencies within its layers. Source files and the Bun lockfile live in the workspace; project dependencies and generated build output stay in containers. The images are Linux containers.

## Start locally

From this directory:

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

The API's identity boundary is deliberately unconfigured and rejects protected operations. Production startup is blocked until a real authentication provider is integrated. Before deployment, select a provider and hosting environment; implement and validate session issuance, logout, revocation, invitation management and the complete role/team authorization policy. Development services and credentials are not a production deployment.
