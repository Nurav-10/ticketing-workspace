-- Additive migration for Phase 5 durable outbox worker slice
-- Adds leasing, dead-letter tracking, error recording, and monotonic workspace sequences.

BEGIN;

-- Additive columns on outbox_events for bounded lease claims and dead-letter handling
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS claimed_by varchar(255),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz(6),
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz(6),
  ADD COLUMN IF NOT EXISTS dead_letter_reason text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS workspace_sequence bigint;

-- Ensure workspace_sequence is positive when present
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_workspace_sequence_positive
  CHECK (workspace_sequence IS NULL OR workspace_sequence > 0);

-- Unique monotonic per-workspace sequence index
CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_workspace_seq_idx
  ON outbox_events (workspace_id, workspace_sequence)
  WHERE workspace_sequence IS NOT NULL;

-- Index for claiming ready, non-dead-lettered pending events
CREATE INDEX IF NOT EXISTS outbox_events_claim_idx
  ON outbox_events (next_attempt_at, created_at)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

-- Index for checking active or expired leases
CREATE INDEX IF NOT EXISTS outbox_events_lease_idx
  ON outbox_events (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

-- Index for dead-letter queue inspections
CREATE INDEX IF NOT EXISTS outbox_events_dead_letter_idx
  ON outbox_events (workspace_id, dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;

-- Dedicated table for per-workspace monotonic sequence allocation under transaction lock
CREATE TABLE IF NOT EXISTS workspace_outbox_sequences (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  next_sequence bigint NOT NULL DEFAULT 1,
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_outbox_sequences_next_sequence_positive CHECK (next_sequence > 0)
);

COMMIT;
