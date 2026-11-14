# Phase 4 — Workflows, views and search

**Goal:** navigate growing issue collections and configure team workflows. Depends on Phase 3.

## 4.1 Workflow configuration

Allow authorized team admins to create, rename and reorder statuses in backlog, unstarted, started, completed or canceled categories. Specify defaults and transitions. Deleting a status with issues requires explicit atomic reassignment. Add workspace/team labels, priority and assignee; reject foreign-workspace references.

## 4.2 Lists, filters and board

Implement cursor-paginated issue lists with deterministic sorting and filters for status, priority, assignee and labels. Add the project filter when projects ship in Phase 6. Specify null ordering and a stable ID tie-breaker. Keep shareable view state in URLs without leaking protected information.

Add status grouping and a board over the same filter model. Provide drag-and-drop and keyboard/menu alternatives. The server validates authorization, version and target status. Define stable ordering, collision handling and concurrent moves; test multiple clients.

Persist saved views with an explicit scope and edit policy. Decide whether manual ordering is shared or personal; encode it in data and UI.

## 4.3 Search

Begin with indexed PostgreSQL full-text search for authorized issue titles and descriptions. Apply workspace/team authorization before returning results, snippets or counts. Specify tokenization, ordering and pagination. Measure large-workspace queries and indexes before adding a separate search service.

## 4.4 Navigation and states

Make filters, grouping, list/board preference, loading and empty results clear. Preserve view state when navigating to detail and using browser back/forward. Ensure touch and keyboard alternatives.

**Acceptance / exit:** members configure permitted workflows, list/filter/group/search authorized issues, save a view and move an issue with pointer or keyboard. Pagination follows documented ordering semantics, and list, board, search, snippets and counts do not expose private data. Status reassignment is atomic and concurrent moves resolve as specified.
