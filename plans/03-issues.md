# Phase 3 — Issues: first end-to-end vertical slice

**Goal:** an authorized member can create and manage a real team issue. Depends on Phases 1–2.

## 3.1 Model and contracts

Create Issue with opaque ID, workspace/team IDs, team-scoped number and display key, title, description, workflow status, priority, optional assignee, creator, version, timestamps and archive state. Title is required and bounded; set description limits and safe rendering rules. Define valid status transitions and whether an assignee must be a team member.

Allocate issue numbers atomically per team within the creation transaction and enforce unique (team_id, issue_number). Define team-key rename semantics: canonical links use stable IDs, and any human-readable historical aliases must remain resolvable without bypassing authorization. Validate status, assignee and team references within the workspace.

## 3.2 Commands and consistency

Add create, detail, edit, transition and archive/restore endpoints. Validate and authorize server-side. Creation accepts an actor/workspace/operation-scoped idempotency key with payload hash and expiry; reuse with a different payload conflicts.

Each update checks an expected version atomically. On conflict, expose current state and provide reload/reapply. Commit issue changes, activity records and outbox events in one transaction. Specify idempotency retention and behavior for incomplete requests.

## 3.3 Issue interface

Build creation dialog and issue detail with title, description, status, priority, assignee and timestamps. Provide copyable links, keyboard focus, clear save feedback and return to the originating list. Use optimistic feedback only with explicit rollback and conflict recovery. Preserve unsaved drafts when practical; never silently overwrite a newer server version.

## 3.4 Verification seam

Add structured audit context without logging issue text or credentials. Define retention and deletion rules. Verify concurrent issue numbering, create retries, duplicate idempotency keys, version conflict, invalid status, cross-tenant links and unauthorized access against real PostgreSQL. Cover create → update → reload and keyboard-only creation end to end.

**Acceptance / exit:** two authorized members can create, open and edit issues; IDs remain unique; stale edits are recoverable; issue, activity and outbox writes remain consistent after failure; outsiders cannot access an issue by guessing its ID or key; reload preserves changes and errors are visible.
