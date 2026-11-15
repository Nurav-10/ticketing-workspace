# Phase 4 reconciliation plan

**Purpose:** reconcile the uncommitted Phase 4 implementation in `D:/All Projects/linear` with this checkout (`C:/Users/vmeth/orca/workspaces/linear/dugong`). This is a read-only comparison and a sequencing plan; no source or original-checkout files were changed.

## Evidence and starting point

- The checkouts have different `HEAD`s: current `f277bdaf94cd718fcc3d7f5d6b8a082cee2ec9d3`; original `e56bcce5e24a52dcace894a6125b879971dee290`.
- The original has extensive uncommitted Phase 4 API, schema, test, and migration work (`apps/api/src/{workflows,views,search,labels,board}`, migrations `20261114000800`–`01800`, plus untracked integration/unit tests). It has `plans/04-workflow-migration-runbook.md` and standalone web board/view components.
- The current checkout contains committed workflow work through `20261115000400_workflows`, plus later slices and integration tests. It also contains migrations absent from the original checkout: `20261115000000_projects_cycles`, `00100_comment_activity_kinds`, `00200_issue_comments`, `00300_durable_outbox`.
- The original runbook explicitly says its migrations and rollout are draft, not deployed/verified; it requires compatible dual writes and old-writer drain before backfill, and says configurable workflow activation is gated on activity/outbox compatibility.
- Current `apps/web/src/features/board/IssueBoard.tsx` and `features/views/SavedViews.tsx` exist as standalone components. No corresponding workflow editor, issue search UI, or clear app-shell/API-client wiring for these Phase 4 features was found in the web feature inventory. Verify the actual route tree before porting.

## Conflicts to resolve before combining changes

### Schema and migration history

1. **Different migration ancestry is the primary blocker.** Original Phase 4 migrations use `20261114000800`–`01800`; current history already advances through `20261115000400_workflows` and includes project/cycle, comment activity, issue comments and durable outbox. Do not copy original migration directories wholesale, renumber applied migrations, or edit either history. Rebase the Phase 4 schema delta onto current schema and author new monotonically ordered migrations after current `00400`.
2. **Competing workflow model contracts.** Both schemas define `WorkflowStatus`/`WorkflowTransition`, but differ in naming and lifecycle (`isRetired` in current vs `isActive` in original), timestamp precision, FK delete policies, uniqueness/index names, and transition endpoint field names (`sourceStatusId`/`targetStatusId` vs `fromStatusId`/`toStatusId`). Choose one canonical contract and align Prisma, SQL, repository adapters, API DTOs and tests. Prefer current schema's established tenant/FK conventions unless evidence demands otherwise.
3. **Status representation and rollout.** Both designs add `Issue.workflowStatusId` while retaining enum `Issue.status`; migration/backfill behavior and issue writes must preserve a single canonical mapping during compatibility. Original runbook correctly blocks backfill until all writers dual-write and old writers are drained. Keep the legacy enum until a later contract migration and prove no null/mismatched/cross-team references before enabling ID-only reads.
4. **Activity enum conflict.** Original Phase 4 migrations add `labels_changed` and workflow audit semantics, while current checkout adds comment/project/cycle activity kinds through its newer base history. Preserve current activity values and extend them additively. Review DB check constraints, `IssueActivityKind`, event serialization, and outbox payload compatibility together; never replace the enum/check with the original narrower definition.
5. **Outbox divergence.** Current checkout has durable outbox fields/sequencing and `WorkspaceOutboxSequence`; original schema snapshot lacks them. Phase 4 mutations must use the current outbox contract and existing issue/activity transaction boundary. Do not port an older `OutboxEvent` model or migration that drops/omits lease, retry, sequence, or dead-letter fields.
6. **Project/cycle and comment models.** The original schema predates current `Comment`, `Project`, `Cycle`, related `Issue` fields/relations and their activity values. Replacing the current schema with that older snapshot would remove them: retain these features and integrate Phase 4 models without deleting or rewriting them.
7. **Search/generated query and board readiness.** Original adds query-version and board-order generation/readiness fields and a set of migrations for search and board order. Port only after reconciling concurrent changes to `Team`/`Issue`; validate generated columns/triggers/indexes against current DB migration conventions and inspect all SQL for assumptions about the legacy enum or status lifecycle.
8. **Saved view ownership.** Original schema has creator and owner plus owner-transfer audit events. Preserve separate author/owner semantics and define offboarding behavior; ensure same-tenant/team integrity and visibility authorization. Current schema has no saved-view baseline, so these are additive new tables, not replacements.

### API and UI integration

- Current already has workflow support in `apps/api/src/workflows` and route composition in `apps/api/src/app.ts`; original adds canonical transition and provisioning flows plus board/search/label/view routes. Compare interfaces before copying to avoid duplicate workflow services or mounting route groups twice.
- Port Phase 4 repository behavior as targeted changes against the current issue and team/membership repositories, preserving current idempotency, access checks, activity writes, and outbox sequencing.
- Wire UI only after API contracts stabilize: mount board and saved views in the authenticated app shell/routes, use the shared typed API client and authorized issue query model, and preserve list/view URL state. Still missing: workflow admin/status editor; search input/results/loading/empty/error states; labels/filter controls; saved-view picker/CRUD; board ordering controls with keyboard alternative; route navigation/back-forward/detail return behavior. Keep controls hidden or clearly unavailable until API + migration gate passes.

## Safe sequencing

1. Freeze migration history as-is and record current schema/API baseline. Resolve the canonical workflow names/lifecycle and activity/outbox event representation before porting code.
2. Reconcile `schema.prisma` additively onto current schema. Keep projects/cycles/comments, current workflow baseline, and durable outbox intact. Generate a migration diff against the current migration head; review SQL for drops, enum replacement, FK scope, timestamp drift, indexes, and constraints. Give the new migrations dates/sequence after `20261115000400`.
3. Port workflow provisioning/dual-write/backfill compatibility code first. Ensure team creation and issue create/transition maintain enum + status ID atomically. Keep configuration changes disabled. Drain old writers, reconcile all teams, then run guarded, bounded, repeatable backfill and scoped consistency checks as described in the original runbook.
4. Add workflow audit, labels, saved views, search, query compiler, and board ordering in separate additive migrations. Make query-version/readiness generations monotonic and ensure readiness gates are idempotent. Use current transaction, activity, outbox, membership and private-team policies.
5. Port API slices one at a time and mount once: canonical workflow read/transition; config admin and retirement/reassignment; shared issue query/filter; labels; board order; search; saved view CRUD/execute. Keep version checks, tenant predicates, authorization, activity, and outbox atomic.
6. Wire UI to those contracts: workflow status consumption/admin, list filters and labels, board + accessible move controls, search, saved views, URL state and conflict recovery. Do not activate controls before corresponding server and migration readiness.
7. Only after compatibility evidence, add a separately reviewed contract migration for non-null workflow status IDs or legacy enum removal. No rollback step may discard Phase 4 data; use forward recovery.

## Validation plan (run after reconciliation; not run for this document)

- From an empty disposable PostgreSQL database and a representative current-schema/data snapshot, apply every migration in order. Verify Prisma schema/client alignment and no destructive SQL against project/cycle/comment/outbox tables or event values.
- Migration tests: all legacy statuses map uniquely within each team; backfill is repeatable and bounded; concurrent legacy writes cannot be overwritten; missing/ambiguous mappings halt; tenant composite FKs reject foreign team IDs; partial failure is recoverable; no issue rows are lost.
- Workflow tests: default/category/edge invariants, status retirement with explicit reassignment, stale workflow/issue versions, private-team/admin authorization, concurrent configuration changes, and atomic issue/activity/outbox writes.
- Issue query/search/labels: grammar bounds, label ANY/ALL behavior, stable keyset paging and cursor binding, search updates after title/description edits, and privacy isolation for results/counts/snippets/facets across public/private teams.
- Saved views/board: private owner vs other member, shared view edit policy and owner offboarding, stale status/label references, copied URL authorization, simultaneous moves, stale order conflicts, deterministic tie handling, and safe readiness/backfill reruns.
- Route composition and UI: routes mounted exactly once; authenticated shell/API client wiring; list/board share filters; accessible workflow editor and keyboard board moves; search and saved-view states; navigation/back-forward and detail return; screen reader announcements, focus, reduced motion, zoom and 360/768/1024/1440 widths.
- Record exact Docker commands, database identity, migration counts, test output, browser/accessibility evidence and representative query plans. Follow repository policy to use Docker-only validation; do not install dependencies or run host Bun/Node/Prisma checks.

## Completion gate

Treat reconciliation as complete only when schema and migrations are additive against current history, workflow backfill compatibility is demonstrated, all current project/comment/outbox behavior remains intact, route/UI wiring is integrated, and the validation evidence above is attached. Until then, keep Phase 4 activation gated and report unresolved decisions or migration blockers explicitly.
