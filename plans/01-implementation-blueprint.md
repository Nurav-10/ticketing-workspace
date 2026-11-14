# Phase 1 implementation blueprint

Status: active execution plan · 14 November 2026. This expands [Phase 1](01-foundations.md) into reviewable slices. The user has required Docker for dependency installation and testing, local Git commits, and cohesive modules following SOLID principles.

## Objective and current state

Build a containerized foundation for an internal, multi-workspace issue tracker. The first milestone provides a real application shell, a PostgreSQL schema and a small API with health/readiness and protected workspace/invitation seams. A real identity provider has not been selected, so the API must fail closed for protected requests and must not claim working sign-in, invitations or production readiness. Staging deployment, a verified identity provider, completed team policies and the full Phase 1 acceptance criteria remain future work until their dependencies are available.

The workspace contains initial, unverified scaffolding. In particular, the current React app and Fastify application contain too much unrelated behavior in single files. Restructure them before treating them as an accepted baseline.

## Non-negotiable execution constraints

- Use Bun as the package manager, Node 24 for the API, and PostgreSQL. Install libraries and run tests, audits, type checks, builds and smoke checks **inside Docker**. Do not create host node_modules or install project libraries into the host. A source lockfile and application source are project files, not installed libraries.
- Use a temporary PostgreSQL service for integration tests, isolated from the development database. Never run destructive test setup against the development or production database.
- Initialize and use local Git only; do not add a remote or push. Commit a coherent slice only after its applicable checks pass. The first documentation-only plan commit can precede dependency installation.
- Every package manifest or lockfile change invokes the dependency safety gate: frozen clean install, graph and provenance review, vulnerability audit, type checks/tests/build, production-oriented validation when feasible and final dependency diff review. Report failed or unavailable checks; do not claim production readiness.
- Keep secrets and private data out of source, images and logs. Development-only credentials must be scoped to the isolated local Docker network and never be presented as production configuration.
- Implement original UI and assets. Support keyboard focus, accessible labels, responsive layout and reduced motion; distinguish unavailable features from functional actions.

## Architecture and module boundaries

Capabilities precede folders: configuration, HTTP transport, authentication, workspace access, invitations and persistence are separate responsibilities. On the web, the application shell, navigation, toolbar, issue workspace and reusable visual primitives have separate responsibilities. Use dependency injection at concrete boundaries, not speculative factories or one class per line.

Two possible API interfaces were considered:

1. **Routes directly query PostgreSQL.** Fewer files at first, but HTTP handlers own policy, SQL, validation and transactions; authorization and failure handling are repeated and are difficult to test independently.
2. **Thin routes call feature services backed by small repositories.** More files, but transport stays separate from policy and persistence; public behavior can be tested with adapters and verified against PostgreSQL. Choose this approach for workspace and invitation operations. Keep transactions inside one persistence boundary and do not introduce a generic repository framework.

### API dependency direction

The composition root creates configuration, logger, PostgreSQL pool, authenticator and feature modules. HTTP route modules depend on application services and request validation. Application services depend on narrow feature-specific ports. PostgreSQL repositories implement those ports and own SQL and transaction boundaries. Domain errors do not depend on Fastify. Configuration and error mapping are centralized; feature modules do not read process environment or construct database pools.

Proposed structure; adjust filenames if a clearer equivalent preserves these responsibilities:

    apps/api/src/
      main.ts                       process lifecycle; creates adapters; starts server
      app.ts                        Fastify composition and plugin registration only
      config/                       parsing, validation, trusted public origin
      http/                         request context, error mapping, health routes
      auth/                         principal contract, authenticator port, fail-closed adapter
      workspaces/                   list route, application service, repository port + PostgreSQL adapter
      invitations/                  redeem route, validation, service, transactional repository
      db/                           pool, migration runner and SQL migrations
      shared/                       only genuinely shared errors and identifiers
    apps/api/test/                  HTTP and configuration contract tests
    apps/api/integration/           isolated PostgreSQL migration and concurrency tests

Interfaces should express observable behavior: authenticate(request) returns a verified principal or none; listWorkspaces(principal) returns only memberships visible to that principal; redeemInvitation(principal, token) commits membership and consumes the invitation atomically or returns a typed error. Authentication claims supplied by clients must never become principals. The real identity adapter, cookie issuance, logout and invite creation are not implemented until the provider and permissions are defined.

Trusted request origins must come from explicit configuration, not the incoming Host header. Unsafe authenticated requests reject missing or untrusted Origin. Production startup must reject an unconfigured authenticator. Lock the invitation and the corresponding user row during redemption so verified email cannot change during the transaction. Keep issuer membership/role and last-owner policies as explicit unresolved gates until create/demote operations are designed.

### Web dependency direction

App is a small composition root. A shell composes a sidebar, toolbar and main workspace. Feature-specific issue workspace components own empty and unavailable states. Shared UI primitives handle repeated behavior and accessibility. CSS is split by tokens/base, shell and feature components; components use semantic names instead of a large global stylesheet. Hooks own interactive state only when interaction is real. No component invents logged-in users or issue records.

Proposed structure:

    apps/web/src/
      main.tsx                      React entry point
      app/                          App composition and page-level layout
      features/workspace/           issue workspace and real loading/empty states
      components/shell/             sidebar, header, navigation
      components/ui/                small reusable primitives when needed
      styles/                       tokens, base, shell and feature styles

Avoid a generic component library or elaborate state framework before actual reuse requires it. Use neutral product naming until a name is selected.

## Delivery slices

### Slice 1 — Plan and repository baseline

- Record this blueprint and the existing product/phase plans. Initialize Git on the local machine, respect configured author identity and ignore generated dependencies, build output, environment files and secrets.
- Commit the planning documents and ignore rules as a documentation-only baseline. No application code or dependency manifest is included in that first commit.
- Done when Git has a local baseline commit and the uncommitted implementation remains available for review.

### Slice 2 — Container and workspace foundation

- Establish root Bun workspaces, Node/Bun Docker image, Compose development database and a separate disposable test database. Keep dependencies inside the image/container. Generate and commit bun.lock from a temporary container.
- Add environment samples, clear Docker commands, development-versus-production warnings, CI entry points and a clean image build. Do not add services or host libraries that are not needed.
- Verify a frozen install, package graph, dependency audit, lock consistency and image build inside Docker. Do not commit package changes before the dependency gate passes.

### Slice 3 — Accessible application shell

- Split the current single-file screen into the web modules above. Build quiet workspace navigation, toolbar and an issue workspace with an honest unavailable or empty state. Use neutral naming; no marketing page, made-up issues, fake user or misleading clickable controls.
- Add visible focus, responsive navigation, keyboard access and reduced-motion behavior. Use reusable primitives only where they remove real repetition.
- Run TypeScript and production frontend build inside Docker. Inspect the rendered desktop and narrow layouts using a browser running inside Docker where available. Record any missing browser checks honestly.

### Slice 4 — API composition, configuration and request boundary

- Split Fastify setup, configuration, health/readiness routes, authentication contract and HTTP errors into cohesive modules. Supply pool/auth dependencies to the composition root. Preserve API behavior while refactoring.
- Add explicit origin configuration and production startup guard. Document the fail-closed identity adapter and its limitations. Health and readiness must communicate their actual scope.
- Verify config errors, health/readiness, protected-route 401, configured-origin checks and fail-closed production startup through observable HTTP/process tests in Docker.

### Slice 5 — Workspace access and invitations

- Split workspace transport, application policy and SQL adapter; require a verified principal for every protected route. Return only the principal's authorized workspaces. Define the role model without inventing unimplemented management actions.
- Split invitation validation, policy and transaction persistence. Hash high-entropy secrets, validate exact verified email, lock the user and invitation rows, consume once and create membership atomically. Email normalization is lowercase and trim only after a documented product policy; never infer Gmail-specific equivalence.
- Exercise schema constraints, cross-workspace membership denial, matching/mismatching verified emails, expiry/revocation, replay and simultaneous redemption with two database connections against the disposable Docker PostgreSQL instance.

### Slice 6 — Integrate and verify

- Start the complete Compose stack. Apply migrations deliberately, check readiness, exercise the public HTTP contracts, run unit and integration suites, typecheck, build and audit in clean containers. Exercise failure paths, not just happy paths.
- Review the final module boundaries, dependency graph and manifest/lock changes. Verify that no host node_modules was created and no secrets are tracked. Commit each coherent verified slice or, where changes cannot be separated without breaking the build, one accurately described local milestone commit.
- Document the current feature boundary: provider-specific login/logout/session issuance, invitation creation, full team authorization, staging, production deployment and other Phase 1 exit criteria remain incomplete. Do not represent scaffold endpoints as a complete ticketing system.

## Test contract

There was no pre-existing source, test runner or test suite to use as a baseline. Use the chosen package's Node test runner for API contracts and PostgreSQL integration; do not claim a test-first RED step unless the failing test was actually observed before the corresponding implementation. Tests should assert externally observable behavior, transaction outcomes and access boundaries rather than internal implementation details.

Required cases: health and unavailable dependency; malformed config; anonymous protected route; permitted workspace listing; exact trusted-origin behavior for authenticated writes; fail-closed production start; database migration and cross-tenant FK rejection; invitation success, wrong/unverified email, expiry, revocation, replay and two concurrent redemptions. Web checks cover responsive rendering, keyboard/focus, visible state and reduced motion. All commands run through Docker.

## Definition of done for this milestone

1. Module boundaries are reflected in code and each public seam has relevant checks.
2. Docker builds and runs without project libraries installed on the host; a clean frozen install and audit have an explicit result.
3. Tests, type checking, builds and the applicable smoke checks have actual results recorded; any failure or limitation is surfaced.
4. Local Git contains a planning commit and a verified implementation commit or commits. No remote operation is performed.
5. The next unimplemented work and the identity/hosting decisions are explicit; Phase 1 is not labeled complete until its full acceptance criteria are met.
