BEGIN;

CREATE TYPE comment_content_format AS ENUM ('plain_text');

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  body varchar(10000),
  content_format comment_content_format NOT NULL DEFAULT 'plain_text',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  edited_at timestamptz(6),
  deleted_at timestamptz(6),
  CONSTRAINT comments_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT comments_workspace_id_team_id_issue_id_fkey
    FOREIGN KEY (workspace_id, team_id, issue_id)
    REFERENCES issues(workspace_id, team_id, id) ON DELETE RESTRICT,
  CONSTRAINT comments_author_user_id_fkey FOREIGN KEY (author_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT comments_body_state_check CHECK ((
    (deleted_at IS NULL AND body IS NOT NULL AND length(btrim(body)) BETWEEN 1 AND 10000)
    OR (deleted_at IS NOT NULL AND body IS NULL)
  ) IS TRUE),
  CONSTRAINT comments_version_positive CHECK (version > 0),
  CONSTRAINT comments_edited_state_check CHECK (edited_at IS NULL OR edited_at >= created_at)
);

CREATE INDEX comments_issue_created_id_idx ON comments (workspace_id, team_id, issue_id, created_at, id);
CREATE INDEX comments_author_idx ON comments (author_user_id, created_at);

CREATE OR REPLACE FUNCTION issue_activity_metadata_is_safe(event_kind issue_activity_kind, metadata jsonb)
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
  IF event_kind = 'project_changed' THEN
    RETURN issue_jsonb_object_size(metadata) = 3
      AND metadata ?& ARRAY['changedFields', 'projectBefore', 'projectAfter']
      AND metadata->'changedFields' = '["projectId"]'::jsonb
      AND jsonb_typeof(metadata->'projectBefore') IN ('string', 'null')
      AND jsonb_typeof(metadata->'projectAfter') IN ('string', 'null')
      AND (jsonb_typeof(metadata->'projectBefore') = 'null' OR metadata->>'projectBefore' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      AND (jsonb_typeof(metadata->'projectAfter') = 'null' OR metadata->>'projectAfter' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      AND metadata->'projectBefore' <> metadata->'projectAfter';
  ELSIF event_kind = 'cycle_changed' THEN
    RETURN issue_jsonb_object_size(metadata) = 3
      AND metadata ?& ARRAY['changedFields', 'cycleBefore', 'cycleAfter']
      AND metadata->'changedFields' = '["cycleId"]'::jsonb
      AND jsonb_typeof(metadata->'cycleBefore') IN ('string', 'null')
      AND jsonb_typeof(metadata->'cycleAfter') IN ('string', 'null')
      AND (jsonb_typeof(metadata->'cycleBefore') = 'null' OR metadata->>'cycleBefore' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      AND (jsonb_typeof(metadata->'cycleAfter') = 'null' OR metadata->>'cycleAfter' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      AND metadata->'cycleBefore' <> metadata->'cycleAfter';
  ELSIF event_kind IN ('created', 'archived', 'restored') THEN
    RETURN metadata = '{}'::jsonb;
  ELSIF event_kind IN ('comment_created', 'comment_edited', 'comment_deleted') THEN
    RETURN issue_jsonb_object_size(metadata) = 2
      AND metadata ?& ARRAY['commentId', 'version']
      AND metadata->>'commentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND jsonb_typeof(metadata->'version') = 'number'
      AND (metadata->>'version') ~ '^[1-9][0-9]*$';
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

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_kind_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_kind_check CHECK (event_kind IN (
  'issue.created', 'issue.updated', 'issue.archived', 'issue.restored',
  'issue.comment.created', 'issue.comment.updated', 'issue.comment.deleted'
));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_payload_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_payload_check CHECK ((
  jsonb_typeof(payload) = 'object'
  AND payload ?& ARRAY['issue_id', 'version']
  AND payload->>'issue_id' = issue_id::text
  AND jsonb_typeof(payload->'version') = 'number'
  AND (payload->>'version') ~ '^[1-9][0-9]*$'
  AND (
    (event_kind LIKE 'issue.comment.%'
      AND issue_jsonb_object_size(payload) = 4
      AND payload ?& ARRAY['comment_id', 'comment_version']
      AND payload->>'comment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND jsonb_typeof(payload->'comment_version') = 'number'
      AND (payload->>'comment_version') ~ '^[1-9][0-9]*$')
    OR (event_kind NOT LIKE 'issue.comment.%' AND issue_jsonb_object_size(payload) = 2)
  )
) IS TRUE);

COMMIT;
