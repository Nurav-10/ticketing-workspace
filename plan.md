# Ticketing system: product and delivery plan

Status: implementation underway · 14 November 2026

The original plan.md was empty. This plan is based on the brief: a Linear-inspired ticketing system with a polished interface, subtle animation and a strong backend. The initial Docker-based foundation and shell are implemented; identity, authorization and the product workflows remain incomplete.

## Problem and outcome

Product and engineering teams need a fast, reliable way to capture work, prioritize it and follow it through to completion. A member should be able to create an issue, find it again, assign it, move it through a team workflow, discuss it and see teammates' updates. Administrators need control over membership and access.

The first release is a responsive web application for internal teams. Its interface should feel calm, dense and quick, with an original visual identity informed by Linear's design principles. Core workflows must operate on real, protected data.

## Assumptions to validate

- The primary users are internal product and engineering teams. External customer submissions and SLAs are later scope unless the product goal changes.
- The application serves multiple organizations. A user can belong to multiple workspaces; workspaces contain teams, and each issue belongs to one team.
- Modern desktop browsers are the primary target, with usable tablet and mobile layouts. Native mobile apps are later scope.
- English and one default theme are sufficient initially. Tokens should allow light and dark themes later.
- Expected users, team size, budget, hosting region and delivery date are unknown. The performance targets below are provisional.
- REA inspected Linear's public marketing page; no authenticated product, private source, backend or private traffic was examined. See [research notes](plans/00-research.md).

## Recommended technology

Use TypeScript across the stack, Bun workspaces for package management, and a modular monolith for the first release.

| Area | Proposal | Why |
| --- | --- | --- |
| Web | React, Vite, TanStack Router and TanStack Query; CSS variables and accessible primitives | Explicit client routing and server-state management, with a reusable design system. |
| API | Node.js LTS, Express and typed REST with OpenAPI | Express is the selected transport; keep business services and authorization independent of the framework. Bun manages packages. |
| Data | PostgreSQL with Prisma ORM and Prisma Migrate | Typed data access and versioned migrations, with database constraints and explicit transactional locking where Prisma's normal operations cannot express the required guarantee. |
| Jobs | Transactional outbox in PostgreSQL and a separate worker | Durable async work without requiring Redis for the first release. Evaluate a maintained queue library before adoption. |
| Live updates | Authenticated server-sent events (SSE), with HTTP writes | Server-to-client events fit the first release; reconnect and resync semantics must be explicit. |
| Authentication | Managed identity provider behind an adapter and a secure application session cookie | Delegate password recovery and identity operations; select a provider after reviewing price, security, residency and portability. |
| Files | Private S3-compatible object storage | Introduce with attachments after MVP; authorize every upload and download. |
| Tooling | Strict TypeScript, migrations, CI, formatter/linter and reproducible local PostgreSQL | Pin versions, commit a lockfile and verify dependencies. Install project dependencies and run checks inside Docker. |

The current repository uses Bun workspaces, React, Fastify, PostgreSQL and a custom SQL migration runner. Express and Prisma are the selected target for the next backend migration; that migration is not complete yet. The remaining technologies are proposals until selected and verified. Keep identity, workspaces, teams, issues, views, projects, cycles, activity and notifications as explicit application modules. Begin with one API and one worker; split services only when measurement justifies the cost.

## Core contracts

Core records: User, Workspace, WorkspaceMembership, Team, TeamMembership, WorkflowStatus, Issue, IssueLabel, Label, Comment, ActivityEvent, Project, Cycle, SavedView, Notification and OutboxEvent. Every tenant-owned record carries a workspace identity; team-scoped records also carry a team identity. Foreign keys and server-side policy checks prevent cross-workspace links. Use opaque internal IDs and unique human-readable issue keys; neither is an authorization credential.

Version the API under /api/v1. Validate workspace context against the authenticated user on every request. Bound list page sizes and validate filters. Mutations return canonical state and a version. Reject stale updates with a recoverable conflict. Retryable creation uses an idempotency key scoped to the actor, workspace and operation; a reused key with a different payload conflicts.

Commit each important issue change, its activity record and its outbox event together. Delivery is at least once and consumers deduplicate by event ID. For the proposed SSE stream, allocate a per-workspace event sequence under a transaction-held lock to preserve commit order. Authorize subscriptions and replay; after a retention gap, require an authorized snapshot/refetch. Benchmark the per-workspace lock before scaling.

## Visual and interaction direction

Use the **CALM** application mode: quiet workspace navigation, compact readable issue rows, a focused content area, contextual issue detail and a discoverable command palette. Define semantic type, spacing, color, radius, elevation and motion tokens. Use a distinct name, assets and visual identity; the public reference is inspiration, not a source of copied branding.

- Support visible keyboard focus, semantic controls, readable contrast, screen readers and reduced motion from the first UI slice.
- Start with 100–180 ms hover and 180–240 ms panel transitions using opacity and transform where practical; tune after observing users. Avoid animating every list reflow.
- Provide loading, empty, denied, offline, stale-data, error and saved states. Shortcuts must not intercept typing, browser shortcuts or assistive technology, and each must have a visible alternative.
- Provisional targets, subject to agreed test conditions: p95 warm navigation feedback under 200 ms; p95 issue mutation API response under 500 ms at a representative defined load; smooth panel transitions on the agreed baseline device. Measure client feedback, server latency and network separately.

## Delivery phases

Phase numbers express dependencies rather than estimates. The proposed beta spans Phases 1–7; Phase 8 is post-launch. CI, accessibility and authorization checks start early and expand with each slice. The active breakdowns are the [Phase 1 foundation blueprint](plans/01-implementation-blueprint.md), [Express and Prisma migration](plans/01-express-prisma-migration.md), [identity implementation](plans/01-identity-implementation.md), [workspace authorization](plans/01-authorization-implementation.md), and [Phase 2 design-system blueprint](plans/02-implementation-blueprint.md).

| Phase | Goal | Depends on |
| --- | --- | --- |
| [0. Research and decisions](plans/00-research.md) | Evidence, product scope and unresolved decisions | None |
| [1. Foundations and identity](plans/01-foundations.md) | Deployable skeleton, auth, workspaces and isolation | 0 |
| [2. Design system and shell](plans/02-design-system.md) | Original visual language, accessible shell and motion | 1 |
| [3. Issues vertical slice](plans/03-issues.md) · [implementation blueprint](plans/03-implementation-blueprint.md) | Create, read, edit and transition real issues | 1–2 |
| [4. Workflows and views](plans/04-workflows-views.md) | Statuses, lists, filters, board and search | 3 |
| [5. Collaboration and sync](plans/05-collaboration.md) | Comments, activity, notifications and live updates | 3–4 |
| [6. Projects and cycles](plans/06-projects-cycles.md) | Group issues and plan team cycles | 3–5 |
| [7. Reliability and launch](plans/07-launch.md) | Security, recovery, performance and beta | 1–6 |
| [8. Expansion](plans/08-expansion.md) | Integrations, attachments and advanced capabilities | 7 and product validation |

## MVP acceptance

1. An invited person can sign in, join an authorized workspace/team and reach their issue list; an outsider cannot read or mutate its data by changing an ID or subscribing to updates.
2. Two teammates can create an issue, assign it, change status and priority, comment, filter for it and see updates. Conflicting edits are surfaced instead of silently lost.
3. A project can group issues and a team can schedule an issue into a cycle; references are validated within the authorized workspace/team.
4. Critical flows work using keyboard, screen reader, reduced motion and a narrow viewport. Loading, error, reconnect and empty states are understandable.
5. The service can be deployed and rolled back with monitored health, reproducible migrations, a practiced backup restore and documented incident ownership.

## Scope and verification

Defer customer portals, SLA engine, billing, marketplace, AI agents, external importers, full offline editing, native apps, enterprise SSO/SCIM, attachments and distributed microservices unless discovery changes priority.

Verify each phase at public API and UI seams: tenant and role matrices; database constraints and transactions; conflicts and retry behavior; keyboard and reduced-motion flows; worker deduplication/recovery; and end-to-end journeys against real PostgreSQL. Security, availability and performance claims require measurable evidence.

Confirm the target users and external ticket requirement, hosting/region, auth provider, expected load, product name/theme and whether projects/cycles are necessary for beta. Assign owners before estimating time or cost.
