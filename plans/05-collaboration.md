# Phase 5 — Collaboration, notifications and live updates

**Goal:** make issue activity and team collaboration reliable across sessions. Depends on Phases 3–4.

## 5.1 Comments and activity

Add comments with actor, timestamps, edited/deleted states, workspace/issue foreign keys and an explicit content format. Sanitize rich content at rendering boundaries; treat mentions as structured references and validate visibility. Define edit/delete permissions, retention and the distinction between activity and security audit records.

Show creation, property changes and comments in chronological activity. Each domain write and corresponding activity record commit atomically.

## 5.2 Durable events and workers

In the same transaction as an issue/comment change, persist an outbox event with a unique event ID and per-workspace sequence. Allocate the sequence under a lock held until commit. A worker claims bounded batches with leases, retries with backoff, records failure/dead-letter state and exposes queue metrics.

Delivery is at least once. Consumers deduplicate by event ID; notification creation is idempotent. Specify recovery after crashes before and after delivery and monitor queue lag, oldest pending age, failures and worker health.

## 5.3 Live updates and notification inbox

Deliver authorized workspace events over SSE. Reconnect from the last processed cursor, replay retained events in sequence, and fetch a fresh authorized snapshot on a cursor gap or expired retention. Use an opaque, authenticated resume cursor so skipped private-team events do not expose their count or sequence positions. On revocation, close/invalidate streams and recheck permissions for replay and delivery. Event payloads contain IDs and minimal metadata; fetch current records under current permissions.

Provide an inbox for assignments and mentions with read/unread state and deep links. Notification creation and later access both respect recipient visibility.

## 5.4 Concurrent and offline states

Reconcile incoming updates with optimistic local edits using version checks. Preserve unsent comments on transient failure and show reconnecting/stale indicators and retry. Full offline write sync and collaborative character-level editing remain out of scope.

**Acceptance / exit:** a second authorized session sees an issue update and comment; a revoked or unrelated member receives neither data nor notifications; worker crashes do not lose events or create duplicate user-visible notifications; reconnect and retention-gap paths resynchronize. Simultaneous edits expose conflicts and logs exclude comment text and credentials.
