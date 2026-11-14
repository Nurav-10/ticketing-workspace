# Phase 3 implementation blueprint — Issues vertical slice

**Status:** implementation in progress. **Updated:** 14 November 2026. This blueprint expands [Phase 3](03-issues.md). Phase 3 depends on Phase 1 identity, sessions, workspace/team authorization and Phase 2's accessible application shell. Existing groundwork does not establish either phase as complete.

**Current Docker evidence:** Prisma schema generation and validation, workspace typecheck and production builds passed; 114 API unit tests, worker/contracts tests, and 40 PostgreSQL integration tests passed against the disposable test service. After review changes, typecheck/build and the issue integration case passed again, including reciprocal cross-workspace assignment and cross-team idempotency races. The case also exercises tenant/private-team access, numbering, pagination, version conflicts, archive/restore and atomic history/outbox behavior. Browser/accessibility validation remains deferred at the user's request; real provider, staging and existing-database baseline validation also remain outstanding. These checks do not establish full Phase 3 acceptance.

## Starting point and readiness gates

The current repository is a Bun/TypeScript workspace. `apps/api` now uses Express 5, Prisma 7, PostgreSQL and dependency-injected feature modules (`routes → service → repository`, with Prisma adapters composed in `src/main.ts`). `buildApp` in `src/app.ts` handles request IDs, JSON parsing, public health/OpenAPI routes, authentication/origin middleware, protected routers and centralized errors. `src/authorization/policy.ts` contains pure workspace/team policy decisions; repository services fetch trusted facts. `src/audit/security-audit-writer.ts` writes policy audit events in a caller-owned Prisma transaction. The schema and migration history have workspace, team, membership, identity/session and security-audit foundations, but no Issue, issue activity or outbox model.

The React/Vite app has a responsive shell and `features/workspace/IssueWorkspace.tsx`; issue actions and data are explicitly unavailable. `workspace-api.ts` is a small fetch boundary and `useWorkspaceAccess.ts` handles sign-in/workspace loading and logout. There is no issue route, router, issue form, issue detail data flow, issue cache or issue UI state yet. Phase 2's blueprint still records incomplete Phase 1 dependencies and outstanding accessibility evidence.

Before enabling issue routes or controls, close the applicable Phase 1/2 gates: a configured identity adapter and usable app session flow; current, verified principals; active workspace and private-team authorization on every request; team/workspace identity in the web app; deployable additive Prisma migrations and a safe baseline process; production and disposable test DB separation; and an accessible shell with real loading/error/unauthorized states. Verify these against their owning blueprints. Do not add mock identities or claim Phase 1/2 acceptance based on this issue work.

## Product defaults for this slice

- An issue belongs to exactly one workspace and one team. The team is the authorization and human-numbering scope. Opaque UUIDs are internal identifiers; a human-readable key is a display/reference aid, never an authorization credential.
- Phase 3 begins with a small built-in workflow (`backlog`, `todo`, `in_progress`, `done`, `canceled`) and an explicit transition table owned by the issue domain. This is temporary system workflow data, not user-editable workflow configuration. Phase 4 owns configurable statuses and workflow administration. If Phase 4's workflow contract is ready sooner, inject a workflow port and use that contract rather than duplicating it.
- Any active workspace member who can read a team may create and manage its issues. Private-team membership remains required for all reads and writes; workspace owner/admin roles do not bypass private-team access. This slice has no per-issue ACL. Keep the policy entry point separate so later role/permission refinement has one seam.
- Assignee, when present, must be an active workspace member and, for private teams, a team member. The creator is the verified principal. Do not accept actor, workspace, number, version, status history or timestamps as trusted request fields.
- Team key changes do not change issue UUIDs or API resource identity. Until alias history is implemented, keys are current display strings only; clients should retain canonical issue URLs using UUIDs. Do not promise resolution of old display keys.
- Archive is a reversible soft state. No issue hard-delete endpoint is in scope. Archived issues are excluded from default lists, discoverable through the authorized archived filter, and readable through detail/history; restore is a version-checked mutation.

## Module map and dependency direction

```text
apps/web/app → features/workspace/issues (view state + workflows) → issue API client
                                                                      ↓ HTTP /api/v1
apps/api/app composition → issues routes → issue service/domain → issue repository port
                                                           ↑             ↑
                                            Principal + policy     Prisma issue adapter
                                                                         ↓
                                                        PostgreSQL + reviewed migrations
```

Keep dependencies pointed inward. HTTP parsing and response envelopes stay in routes; business rules and error intent stay in the issue service/domain; persistence, transaction isolation and SQL locking stay in the Prisma adapter. React components never decide authorization. Do not make repositories import Express or React, and do not let routes contain Prisma queries. Add shared contracts to `packages/contracts` only when both browser and API need the same stable wire shape; never share Prisma model types with the browser.

Suggested feature files (adjust names to local conventions, preserving ownership):

| Module | Owns |
| --- | --- |
| `apps/api/src/issues/issue-domain.ts` | input/output types, title/description limits, workflow transition rules, version semantics, domain errors |
| `apps/api/src/issues/issue-service.ts` | principal-to-command mapping and use cases; no Express or Prisma dependency |
| `apps/api/src/issues/issue-repository.ts` | narrow repository port and transaction-ready command/query shapes |
| `apps/api/src/issues/prisma-issue-repository.ts` | tenant-scoped reads, authorization facts, number allocation, expected-version writes, activity/outbox persistence |
| `apps/api/src/issues/issue-routes.ts` | versioned endpoint registration, strict body/query validation, status codes and ETags/version serialization |
| `apps/web/src/features/issues/issue-api.ts` | same-origin credentialed fetch, typed envelope/error decoding, abort support |
| `apps/web/src/features/issues/` | issue list/detail/create/edit workflow UI and accessible states |

`app.ts` receives an `IssueService` interface and mounts the router behind the existing protected-router middleware; `main.ts` constructs the Prisma repository and service. Keep issue authorization in transaction-aware service/repository operations. A pure policy helper can decide a result from trusted facts, like `decideTeamAction`; it does not authenticate, fetch facts, enforce tenant scoping or prevent TOCTOU races by itself.

## Data and API contract

### Persistence model

Add an additive Prisma migration after the currently applied migration history; never edit a migration already applied. The Prisma schema should represent the full model with `@map`/`@@map`, while reviewed SQL preserves invariants Prisma cannot express.

- `issues`: UUID primary key; `workspace_id`, `team_id`; `issue_number`; bounded nonempty `title`; nullable bounded `description`; `status`; `priority`; nullable `assignee_user_id`; `created_by_user_id`; positive integer `version`; `created_at`, `updated_at`; nullable `archived_at`. Include unique `(team_id, issue_number)`, a tenant composite FK `(workspace_id, team_id) → teams(workspace_id, id)`, and indexes supporting team list ordering/filtering and assignee lookup. Store priority as a checked small enum/text value (`none`, `low`, `medium`, `high`, `urgent`) until product decisions require a different scale.
- Extend `teams` with `next_issue_number` initialized to 1 and constrained positive, or use an equivalent dedicated counter table. Prefer a counter updated with `UPDATE … SET next_issue_number = next_issue_number + 1 … RETURNING next_issue_number - 1` within the create transaction. The database unique constraint remains the final duplicate guard. Avoid `MAX(issue_number) + 1` and process-local counters.
- Keep status, priority and version checks in PostgreSQL as well as TypeScript. Status transitions are checked by the domain using a finite explicit graph; direct writes to an arbitrary status are impossible through the public API.
- `issue_activity_events`: append-only logical history for create, field changes, archive and restore. Include UUID, workspace/team/issue IDs, actor ID, event kind, safe structured metadata, and DB timestamp. Metadata is an allowlist of changed field names and safe before/after values (status/priority/assignee IDs); do not store title, description, credentials, raw request bodies or arbitrary user text. Add same-tenant FKs and indexes `(issue_id, created_at, id)` and `(workspace_id, created_at)`.
- `outbox_events`: durable delivery seam for the later Phase 5 live updates. Include event UUID, workspace/team/resource IDs, event kind, schema version, safe payload, created/delivered timestamps and bounded retry metadata. Add a claim index for pending rows. The issue transaction writes it, but Phase 3 does not promise a running publisher or live UI updates. Avoid payloads containing issue descriptions/titles; clients refetch authorized state.
- Store a unique idempotency key scoped by actor/workspace/operation with a canonical request hash and resource reference. The hash includes the workspace and team so a retry cannot resolve to another team's issue. Use the database clock for a 24-hour retention; after expiry, reuse requires locking and replacing the expired row within the create transaction. A same-key/same-hash retry returns the same issue after current authorization, using its current representation if it has since changed; a different hash returns 409; an incomplete/rolled-back request reserves nothing. Clean expired records in bounded batches without deleting a live or newly renewed row.

  The Prisma repository provides a bounded cleanup hook; scheduling and monitoring it are an operational responsibility until the worker has a real job scheduler.

Do not add a per-issue security audit event for ordinary content changes to the existing security audit log: that log intentionally has a small policy-event vocabulary and sensitive metadata constraints. `issue_activity_events` is product history, not a substitute for append-only security audit.

### HTTP resources

All endpoints are under `/api/v1/workspaces/:workspaceId/teams/:teamId/issues`; detail/mutation routes address `:issueId`. Require the session principal and exact configured `Origin` on unsafe requests through existing middleware. Use `{ data: ... }` success envelopes and the existing `{ error: { code, message, requestId } }` shape.

| Method and path | Behavior |
| --- | --- |
| `POST /.../issues` | Create; require `Idempotency-Key`; return 201 with canonical issue representation and `ETag`/version |
| `GET /.../issues` | List with bounded `limit` (default 50, maximum 100), stable cursor/order and optional exact status/priority/assignee filters; exclude archived by default |
| `GET /.../issues/:issueId` | Fetch issue and optionally paginated activity history; resource is always resolved under workspace and team scope |
| `PATCH /.../issues/:issueId` | Edit title, description, priority and/or assignee; require `If-Match` or `expectedVersion`; reject unknown fields and empty patches |
| `POST /.../issues/:issueId/transitions` | Transition to a valid target status with expected version; distinct action makes the workflow rule explicit |
| `POST /.../issues/:issueId/archive` and `/restore` | Reversible, expected-version checked state changes |

Responses expose the stable UUID, current display key (`team.key + issue_number`), team/workspace IDs, title/description, status/priority, assignee and creator summaries allowed by membership policy, version and timestamps. Do not return private membership details. Use 404 for a missing issue or one outside the requested team/workspace to avoid cross-tenant existence leaks; use 403 only after a resource is known to be in-scope and policy explicitly distinguishes denial. Return 409 for stale versions, illegal transitions, idempotency payload mismatch and exhausted number/key conflicts; return 400 for malformed input, 401 for no principal, 413 for oversize JSON, and a generic 500 for unclassified storage failures. Map known Prisma/PostgreSQL constraint errors narrowly; never expose SQL, params or description text in errors/logs.

The create and update validators must have explicit UTF-8/body limits. Suggested first limits: title 1–250 characters after trim, description up to 20,000 characters, and API JSON body ≤32 KB (already the app parser default). Decide and document markdown/plain-text rendering policy before showing descriptions; render as text or sanitize a narrowly specified markdown subset, never raw HTML. Preserve user line breaks and avoid executing embedded links/HTML.

## Authorization and concurrency invariants

1. Start each mutation transaction by resolving/locking the workspace and team in workspace-first order, then the actor's active workspace membership and relevant private-team membership. Follow existing service lock-order conventions. Re-check authorization in the same transaction as the write; do not authorize against cached browser state or a prior request.
2. Apply `decideTeamAction(..., 'readContent')` semantics to issue access for both workspace-visible and private teams, with IDs required to match the request scope. The issue repository query itself includes workspace/team predicates. Workspace owners/admins receive no private-team content bypass. Validate assignee membership/team access in that same transaction; reject stale or cross-tenant references without revealing them.
3. Every update includes `WHERE id = … AND workspace_id = … AND team_id = … AND version = expectedVersion AND archived_at IS [NOT] NULL` as appropriate, and atomically increments version. Zero affected rows becomes a generic stale/not-found conflict after a scoped current-state check. Version checks apply to archive/restore and transitions too.
4. Issue numbering is allocated atomically from the team counter. Rollback returns the number to the available sequence by rolling back the counter update with issue creation. Concurrent creators may proceed in parallel on different teams; same-team allocation serializes briefly at the counter row. Do not use advisory locks unless profiling shows a concrete need.
5. In one transaction, persist the issue mutation, one activity event and one outbox row. If any write fails, roll all three back. For idempotent create, store the idempotency result in that transaction so the response cannot be lost independently of the issue. Version conflicts do not emit activity/outbox rows.
6. Use a consistent lock order (workspace → team → workspace membership rows, actor then target sorted by UUID if more than one → issue/counter/idempotency rows); document exceptions and bound Prisma transaction wait/timeout. Prevent deadlocks by never acquiring these in a reverse order. Retry only known serialization/deadlock errors a small bounded number of times, and only where the command is safe/idempotent.
7. Read paths use `findFirst`/equivalent with all tenant keys plus current membership/team visibility predicates; never fetch an issue globally by UUID and authorize afterward. Lists are bounded and cursor on `(created_at, id)`. Issue and activity creation timestamps use millisecond precision so JavaScript cursor serialization preserves the exact database value; the UUID breaks ties.

## Web workflows and accessibility

Replace unavailable issue actions only when Phase 1's real workspace/team context and API are available. Keep app composition in `app/`; the issue feature owns query state and presentation. Extend `workspace-api.ts` only for cross-feature primitives (shared request/error handling) rather than turning it into a feature god-module. Avoid adding a router/query-library dependency solely for this slice without an explicit package/dependency review; a small existing-stack fetch hook is sufficient initially.

- **Find and open:** show issues for the selected authorized team, loading/empty/error/denied states and a clear refresh/retry action. Clicking a row opens detail while preserving the originating list/filter and supports browser back. Detail route/state uses UUID, not issue key.
- **Create:** a labeled dialog or focused page with required title, optional description, priority and assignee. Use native form submission, field-level validation with `aria-describedby`/`aria-invalid`, focus the first invalid field, announce save/error results, disable duplicate submit while pending and retain the draft after recoverable failures. Provide a visible button as the alternative to any shortcut.
- **Edit and transition:** clearly distinguish editing from read-only detail; status/priority/assignee controls use real server options. Display save state and last-updated/version information. On 409, retain local edits, explain that a newer version exists, and offer reload or reapply against the latest version. Never silently overwrite newer server state. If optimistic feedback is used, rollback to the server state on error and keep the conflict recovery path explicit.
- **Archive/restore:** confirm destructive-feeling archive in context, announce success, and offer undo via restore; a screen-reader user must hear the changed state. Archive does not discard the detail/history or imply permanent deletion.
- **Keyboard and responsive use:** native buttons/links/inputs, predictable tab order, visible focus, Escape and focus restoration for dialogs, no shortcut interception while typing, and usable detail at narrow widths. Follow the existing 360/768/1024/1440 layout checkpoints and 200% zoom target. Respect `prefers-reduced-motion`; no essential state relies on animation or color alone. Provide text labels for icon-only controls and status/priority badges.
- **Privacy:** never place issue descriptions in URLs, telemetry, error text, application logs or analytics. Show only people the viewer is allowed to see. Errors are readable, local to the action, and not announced repeatedly on every render.

## Delivery sequence and reviewable commits

Each commit should be independently reviewable and should not claim completion before its acceptance evidence. Keep migrations and generated Prisma client changes with their schema-owning slice. Root Docker/Compose/lockfile changes are coordinated with the repo owner and only made when required.

1. **Readiness / contract decision** — reconcile Phase 1 and Phase 2 remaining work; confirm issue status graph, limits, assignee rules, archive visibility, idempotency retention, and `If-Match` vs body version contract. Document any deviation here before coding. No issue controls are activated.
2. **Additive schema + repository port** — add issue/counter/activity/outbox/idempotency Prisma models and reviewed SQL migration; regenerate client in Docker. Keep current data intact and preserve baseline snapshot. Review fresh-database migration and baseline adoption implications before application.
3. **Domain + pure policy** — add validators, transition graph, public types, stable error vocabulary, version semantics and issue-action policy seam. Unit-test pure behavior in Docker before routes.
4. **Transactional persistence vertical slice** — implement create and read/detail, tenant scoped access, atomic numbering, idempotent retries, activity and outbox writes; add integration coverage for cross-tenant/private-team denial and number races.
5. **Mutation commands** — add expected-version edit, transition, archive/restore, assignee checks and activity/outbox atomicity. Add stale-write and rollback integration cases.
6. **HTTP contract** — mount protected routes in `app.ts`, inject `IssueService` from `main.ts`, validate strict requests and map stable errors. Verify real HTTP envelopes/status/headers and absence of identity spoofing.
7. **Web read/create/detail** — introduce the issue API boundary and real loading/error/empty states, then create dialog and issue detail/list data flows. Add keyboard and responsive interactions without activating unsupported Phase 4 filters/boards.
8. **Web edit/recovery + accessibility review** — implement version-aware changes, conflicts, archive/restore, saved feedback, keyboard-only walkthrough and reduced-motion behavior. Measure contrast and record browser checks; no accessibility acceptance by visual inference.
9. **Integrated review and handoff** — review schema/query authorization paths, retry and transaction rules, UI errors and Phase 1/2 gates. Record Docker commands and results plus any remaining work. Phase 3 exit is pending until all criteria in `03-issues.md` are evidenced.

## Docker-only verification plan

Do not install packages, run Bun/Node/Prisma tests or builds on the host. Use the repository's Compose-built application image and isolated `db-test` service; never point an integration test, migration experiment or cleanup script at the development `db` volume or production. Extend `apps/api/integration/test-database.ts`'s exact allowlist rather than weakening it. Use unique test identifiers and explicit row cleanup in the disposable test database; do not introduce an automatic reset path for the development database.

For rollout, verify a backup and apply the additive issue migration before enabling a build that queries the new tables. Rolling application code back must leave the issue tables and their data intact; do not automatically drop them or reset the database. A database rollback or recovery involving already-created issues requires a separately reviewed restore/forward-migration plan. The existing development database still requires its guarded Prisma baseline before any pending migrations can be deployed.

Run only after implementation and through Docker, with exact commands/results recorded in the phase handoff:

- API static checks: `docker compose run --rm api bun run --filter @ticketing/api typecheck` and build; ensure Prisma client generation/validation runs against the updated schema in the same image.
- Unit: issue title/description validation, transition matrix, stable API error mapping, cursor bounds, idempotency payload hash/expiry rules and service behavior with repository fakes.
- PostgreSQL integration: empty disposable DB migration; safe upgrade/baseline documentation review; composite tenant FKs and check constraints; simultaneous creates on one team produce distinct sequential numbers; separate teams allocate independently; same idempotency key/same payload returns the same issue; mismatched payload conflicts; transaction failure leaves no issue/activity/outbox/counter side effects; stale edits have one winner; invalid transition and invalid assignee reject; archived issue default filtering and restore; cross-workspace and unauthorized private-team read/write are denied even with guessed UUID/key; workspace admin outside a private team is denied; a legitimate private-team member succeeds.
- HTTP integration: actual Express app and ephemeral local port, unauthenticated and Origin rejection cases, body/unknown-field validation, list bounds, 404 disclosure policy, ETag/version responses and stable error envelope. Test no request body/header can set actor/workspace identity.
- Web: `docker compose run --rm web bun run --filter @ticketing/web typecheck` and production build. When browser tooling is available, exercise create → detail → edit → reload, conflict recovery, archive/restore and keyboard-only create at 360/768/1024/1440 widths, 200% zoom and reduced motion. Record contrast measurements, not impressions.
- Run dependency safety review only if package manifests/lockfile change; keep that review and any parent-owned lockfile/Docker changes with their implementation owner.

Do not report these checks as passed until they have actually run. Planning this test seam is not evidence that Phase 1, Phase 2 or Phase 3 acceptance has passed.

## Phase 3 exit evidence

Two authorized members can create, open and edit real issues in an authorized team; concurrent numbering is unique; idempotent retry cannot duplicate; stale edits are recoverable; transitions and references are validated; issue, activity and outbox writes commit or roll back together; outsiders cannot read by UUID or display key; web reload shows persisted changes; keyboard-only create and accessible errors work. Attach Docker test outputs and browser/accessibility evidence, and list any missing Phase 1/2 operational gates separately. Until then, status remains in progress.
