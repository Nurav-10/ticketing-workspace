# CI checks

GitHub Actions runs the repository checks in `.github/workflows/ci.yml`. It builds the `api` Compose image first; the Dockerfile performs `bun install --frozen-lockfile` and Prisma client generation inside that image. Audit, typecheck, build, unit tests, and PostgreSQL integration tests then run as commands in the built container. CI does not install Bun or project packages on the runner and does not run browser tests.

Integration tests start only the Compose `db-test` service. That service uses a separate database and role, an ephemeral `tmpfs` data directory, and a health check. The integration harness requires `TEST_DATABASE_URL` to identify that service and rejects a test URL that matches `DATABASE_URL`. The CI development URL is only a distinct placeholder; no development database is started or used. Integration migrations and fixtures stay inside this temporary database.

The workflow needs no repository secrets and grants only `contents: read`. It does not publish images or deploy. Docker may pull the pinned base images used by the repository's Dockerfile. The final cleanup step removes Compose containers, networks, and volumes even when a check fails.

The checks cover dependency audit, TypeScript, production builds, API unit tests, and API PostgreSQL integration tests. Browser rendering and interaction checks are not part of CI yet.
