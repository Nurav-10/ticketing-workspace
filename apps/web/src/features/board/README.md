# Issue board feature module

Design mode: CALM. This module is a standalone presentation component; it is intentionally not imported by the app shell or registered as a route.

`IssueBoard` accepts canonical workflow columns, their order versions, and issue data as props. Column badges show the number of currently supplied/visible issues; they are not authoritative totals. Mutations are emitted only through `onMoveIssue`, with the issue's `expectedIssueVersion`, source/target `expectedOrderVersions`, target status ID, and an explicit placement (`beforeIssueId`, `afterIssueId`, or `append`). A successful mutation should return the server's canonical issue and the parent should refresh/reconcile its issue result set. A conflict is kept as a pending intent; the user can refresh, then explicitly reapply using refreshed issue and order versions.

Keyboard users can choose a permitted destination status and a position relative to a named issue, then activate Move. Pointer users can drag a card before another issue or to the end of a permitted column, including within its current column. Status and order actions have no local optimistic persistence. Screen-reader announcements report successful moves, and errors/conflicts remain available in a live alert.

## Integration and backend contract requirements

- Do not mount until Phase 1/2 authorization and Phase 3 exit evidence and the Phase 4 workflow-read gate are accepted. The current issue API still exposes the legacy `status` enum; it does not supply the canonical workflow IDs, transition graph, board order or ordering version needed here.
- The parent must provide authorized, filtered issue results and workflow columns in canonical order. It must not infer hidden issue counts or use this component as an authorization boundary.
- The Phase 4 API contract must define board ordering, group/order version semantics, an authorized transition command, `expectedVersion` behavior, stable before/after anchors, and recoverable `409` handling. The current callback shape is a UI seam, not a claim that these endpoints exist.
- `onRefresh` must resolve to a snapshot containing both fresh canonical issues and columns with their order versions before reapply is offered. `onMoveIssue` must return a typed conflict/error result; on success return the canonical updated issue or refresh the parent data.
- Project filters are deferred to Phase 6 per the blueprint. This component does not implement filters, paging, counts, search, saved views, issue detail, authorization, or an API client.

No tests, typechecks, builds, package commands or browser checks were run for this component.
