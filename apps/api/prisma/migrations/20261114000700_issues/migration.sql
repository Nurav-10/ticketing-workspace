BEGIN;

CREATE TYPE issue_status AS ENUM ('backlog', 'todo', 'in_progress', 'done', 'canceled');
CREATE TYPE issue_priority AS ENUM ('none', 'low', 'medium', 'high', 'urgent');
CREATE TYPE issue_activity_kind AS ENUM ('created', 'fields_changed', 'status_changed', 'archived', 'restored');

CREATE FUNCTION issue_jsonb_object_size(value jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE WHEN jsonb_typeof(value) = 'object'
    THEN (SELECT count(*) FROM jsonb_object_keys(value))
    ELSE -1 END
$function$;

CREATE FUNCTION issue_activity_metadata_is_safe(event_kind issue_activity_kind, metadata jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  changed_field jsonb;
  has_priority boolean;
  has_assignee boolean;
BEGIN
  IF jsonb_typeof(metadata) <> 'object' THEN RETURN false; END IF;
  IF event_kind IN ('created', 'archived', 'restored') THEN
    RETURN metadata = '{}'::jsonb;
  ELSIF event_kind = 'status_changed' THEN
    RETURN issue_jsonb_object_size(metadata) = 2
      AND metadata ?& ARRAY['statusBefore', 'statusAfter']
      AND jsonb_typeof(metadata->'statusBefore') = 'string'
      AND jsonb_typeof(metadata->'statusAfter') = 'string'
      AND metadata->>'statusBefore' IN ('backlog', 'todo', 'in_progress', 'done', 'canceled')
      AND metadata->>'statusAfter' IN ('backlog', 'todo', 'in_progress', 'done', 'canceled')
      AND metadata->>'statusBefore' <> metadata->>'statusAfter';
  ELSIF event_kind = 'fields_changed' THEN
    IF NOT (metadata ? 'changedFields')
      OR jsonb_typeof(metadata->'changedFields') <> 'array'
      OR issue_jsonb_object_size(metadata) NOT BETWEEN 1 AND 5
      OR (metadata - ARRAY['changedFields', 'priorityBefore', 'priorityAfter', 'assigneeBefore', 'assigneeAfter']) <> '{}'::jsonb
      OR jsonb_array_length(metadata->'changedFields') NOT BETWEEN 1 AND 4
    THEN RETURN false; END IF;
    FOR changed_field IN SELECT value FROM jsonb_array_elements(metadata->'changedFields') LOOP
      IF jsonb_typeof(changed_field) <> 'string'
        OR changed_field #>> '{}' NOT IN ('title', 'description', 'priority', 'assigneeUserId')
      THEN RETURN false; END IF;
    END LOOP;
    has_priority := metadata->'changedFields' @> '["priority"]'::jsonb;
    has_assignee := metadata->'changedFields' @> '["assigneeUserId"]'::jsonb;
    IF has_priority <> (metadata ? 'priorityBefore' AND metadata ? 'priorityAfter')
      OR (metadata ? 'priorityBefore') <> (metadata ? 'priorityAfter')
      OR has_assignee <> (metadata ? 'assigneeBefore' AND metadata ? 'assigneeAfter')
      OR (metadata ? 'assigneeBefore') <> (metadata ? 'assigneeAfter')
    THEN RETURN false; END IF;
    IF has_priority AND (
      jsonb_typeof(metadata->'priorityBefore') <> 'string'
      OR jsonb_typeof(metadata->'priorityAfter') <> 'string'
      OR metadata->>'priorityBefore' NOT IN ('none', 'low', 'medium', 'high', 'urgent')
      OR metadata->>'priorityAfter' NOT IN ('none', 'low', 'medium', 'high', 'urgent')
      OR metadata->>'priorityBefore' = metadata->>'priorityAfter'
    ) THEN RETURN false; END IF;
    IF has_assignee AND (
      NOT (jsonb_typeof(metadata->'assigneeBefore') IN ('string', 'null'))
      OR NOT (jsonb_typeof(metadata->'assigneeAfter') IN ('string', 'null'))
      OR (jsonb_typeof(metadata->'assigneeBefore') = 'string' AND metadata->>'assigneeBefore' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR (jsonb_typeof(metadata->'assigneeAfter') = 'string' AND metadata->>'assigneeAfter' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR metadata->'assigneeBefore' = metadata->'assigneeAfter'
    ) THEN RETURN false; END IF;
    RETURN true;
  END IF;
  RETURN false;
END
$function$;

ALTER TABLE teams
  ADD COLUMN next_issue_number integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT teams_next_issue_number_positive CHECK (next_issue_number > 0);

CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  issue_number integer NOT NULL,
  title varchar(250) NOT NULL,
  description varchar(20000),
  status issue_status NOT NULL DEFAULT 'backlog',
  priority issue_priority NOT NULL DEFAULT 'none',
  assignee_user_id uuid,
  created_by_user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz(6),
  CONSTRAINT issues_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT issues_workspace_id_team_id_fkey FOREIGN KEY (workspace_id, team_id)
    REFERENCES teams(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT issues_assignee_user_id_fkey FOREIGN KEY (assignee_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT issues_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT issues_team_id_issue_number_key UNIQUE (team_id, issue_number),
  CONSTRAINT issues_workspace_id_team_id_id_key UNIQUE (workspace_id, team_id, id),
  CONSTRAINT issues_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT issues_number_positive CHECK (issue_number > 0),
  CONSTRAINT issues_title_nonempty CHECK (length(btrim(title)) BETWEEN 1 AND 250),
  CONSTRAINT issues_description_length CHECK (description IS NULL OR length(description) <= 20000),
  CONSTRAINT issues_version_positive CHECK (version > 0)
);

CREATE INDEX issues_team_created_at_id_idx
  ON issues (workspace_id, team_id, created_at DESC, id DESC);
CREATE INDEX issues_team_status_created_at_id_idx
  ON issues (workspace_id, team_id, status, created_at DESC, id DESC);
CREATE INDEX issues_team_priority_created_at_id_idx
  ON issues (workspace_id, team_id, priority, created_at DESC, id DESC);
CREATE INDEX issues_workspace_assignee_idx ON issues (workspace_id, assignee_user_id);

CREATE TABLE issue_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  event_kind issue_activity_kind NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT issue_activity_events_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT issue_activity_events_workspace_id_team_id_fkey FOREIGN KEY (workspace_id, team_id)
    REFERENCES teams(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT issue_activity_events_workspace_id_team_id_issue_id_fkey
    FOREIGN KEY (workspace_id, team_id, issue_id)
    REFERENCES issues(workspace_id, team_id, id) ON DELETE RESTRICT,
  CONSTRAINT issue_activity_events_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT issue_activity_events_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object') IS TRUE),
  CONSTRAINT issue_activity_events_metadata_safe_check CHECK (
    issue_activity_metadata_is_safe(event_kind, metadata) IS TRUE
  )
);

CREATE INDEX issue_activity_events_issue_created_at_id_idx
  ON issue_activity_events (issue_id, created_at, id);
CREATE INDEX issue_activity_events_workspace_created_at_idx
  ON issue_activity_events (workspace_id, created_at);

CREATE FUNCTION issue_activity_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'issue activity events are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'issue_activity_events_append_only';
END
$function$;
CREATE TRIGGER issue_activity_events_reject_row_mutation
  BEFORE UPDATE OR DELETE ON issue_activity_events
  FOR EACH ROW EXECUTE FUNCTION issue_activity_reject_mutation();
CREATE TRIGGER issue_activity_events_reject_truncate
  BEFORE TRUNCATE ON issue_activity_events
  FOR EACH STATEMENT EXECUTE FUNCTION issue_activity_reject_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE issue_activity_events FROM PUBLIC;

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  event_kind varchar(64) NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz(6),
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbox_events_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT outbox_events_workspace_id_team_id_fkey FOREIGN KEY (workspace_id, team_id)
    REFERENCES teams(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_events_workspace_id_team_id_issue_id_fkey
    FOREIGN KEY (workspace_id, team_id, issue_id)
    REFERENCES issues(workspace_id, team_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_events_kind_check CHECK (event_kind IN ('issue.created', 'issue.updated', 'issue.archived', 'issue.restored')),
  CONSTRAINT outbox_events_schema_version_positive CHECK (schema_version > 0),
  CONSTRAINT outbox_events_payload_check CHECK ((
    jsonb_typeof(payload) = 'object'
    AND payload ?& ARRAY['issue_id', 'version']
    AND issue_jsonb_object_size(payload) = 2
    AND payload->>'issue_id' = issue_id::text
    AND (payload->>'version') ~ '^[1-9][0-9]*$'
  ) IS TRUE),
  CONSTRAINT outbox_events_retry_count_bounded CHECK (retry_count BETWEEN 0 AND 100)
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

CREATE TABLE issue_idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  operation varchar(64) NOT NULL,
  key varchar(255) NOT NULL,
  payload_hash bytea NOT NULL,
  issue_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz(6) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '24 hours'),
  CONSTRAINT issue_idempotency_records_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT issue_idempotency_records_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT issue_idempotency_records_workspace_id_team_id_issue_id_fkey
    FOREIGN KEY (workspace_id, team_id, issue_id)
    REFERENCES issues(workspace_id, team_id, id) ON DELETE RESTRICT,
  CONSTRAINT issue_idempotency_records_scope_key UNIQUE (workspace_id, actor_user_id, operation, key),
  CONSTRAINT issue_idempotency_records_hash_length CHECK (octet_length(payload_hash) = 32),
  CONSTRAINT issue_idempotency_records_operation_check CHECK (operation = 'issue.create'),
  CONSTRAINT issue_idempotency_records_key_nonempty CHECK (length(key) BETWEEN 1 AND 255),
  CONSTRAINT issue_idempotency_records_response_check CHECK ((
    jsonb_typeof(response) = 'object'
    AND issue_jsonb_object_size(response) = 1
    AND response->>'issue_id' = issue_id::text
  ) IS TRUE),
  CONSTRAINT issue_idempotency_records_lifetime_check CHECK (
    expires_at = created_at + interval '24 hours'
  )
);
CREATE INDEX issue_idempotency_records_expires_at_idx ON issue_idempotency_records (expires_at);

COMMIT;
