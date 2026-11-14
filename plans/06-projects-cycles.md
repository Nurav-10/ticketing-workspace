# Phase 6 — Projects and cycles

**Goal:** group issues into projects and plan team work in time-boxed cycles. Depends on Phases 3–5. Confirm during discovery whether beta requires both features.

## 6.1 Projects

Add workspace-owned projects with name, description, owner, status and optional dates. Start with one owning team per project; cross-team membership requires a separate authorization design. An issue belongs to at most one project. Validate workspace/team compatibility on assignment.

Define how private-team access affects project lists and counts: users must not infer hidden issue titles, counts or activity. Provide project list, detail, issue membership and progress based on explicit status categories; specify which authorized issues contribute and whether counts are live.

## 6.2 Cycles

Add team-scoped cycles with title, timezone-aware start/end, lifecycle (planned, active, completed) and issue association. Begin with manual creation and explicit completion; decide whether recurring scheduling is needed later.

Enforce non-overlapping cycle dates per team under concurrent writes, define boundaries as start inclusive and end exclusive, and reject cross-team assignments. If historical completion metrics are added, define snapshots explicitly; do not present a live issue list as historical truth.

## 6.3 Planning interface

Add project and cycle navigation, assignment controls, loading and empty states, and keyboard alternatives. Keep issue detail and lists synchronized with canonical server state. Defer charts, estimates, automation and dependency graphs until their semantics are agreed.

**Acceptance / exit:** an authorized member can create a project and cycle, assign/remove an eligible issue and see the result after reload. Cross-workspace and cross-team references are rejected; private issues and counts remain protected. Overlap enforcement holds under concurrent creation and timezone boundary cases.
