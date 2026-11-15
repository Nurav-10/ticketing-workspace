-- Additive Phase 6 project/cycle grouping. Existing issues remain ungrouped.
ALTER TYPE issue_activity_kind ADD VALUE 'project_changed';
ALTER TYPE issue_activity_kind ADD VALUE 'cycle_changed';
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
CREATE TYPE project_status AS ENUM ('planned', 'in_progress', 'completed', 'canceled');
CREATE TYPE cycle_status AS ENUM ('planned', 'active', 'completed');

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  description varchar(5000),
  status project_status NOT NULL DEFAULT 'planned',
  start_at timestamptz(6),
  target_at timestamptz(6),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT projects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT projects_workspace_team_fkey FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT projects_creator_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT projects_workspace_team_id_key UNIQUE (workspace_id, team_id, id),
  CONSTRAINT projects_dates_ordered CHECK (start_at IS NULL OR target_at IS NULL OR start_at <= target_at)
);
CREATE INDEX projects_team_status_created_idx ON projects(workspace_id, team_id, status, created_at DESC);

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  start_at timestamptz(6) NOT NULL,
  end_at timestamptz(6) NOT NULL,
  status cycle_status NOT NULL DEFAULT 'planned',
  completed_at timestamptz(6),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT cycles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT cycles_workspace_team_fkey FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT cycles_creator_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT cycles_workspace_team_id_key UNIQUE (workspace_id, team_id, id),
  CONSTRAINT cycles_dates_ordered CHECK (start_at < end_at),
  CONSTRAINT cycles_completion_consistent CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT cycles_no_team_overlap EXCLUDE USING gist
    (workspace_id WITH =, team_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
);
CREATE INDEX cycles_team_start_idx ON cycles(workspace_id, team_id, start_at);

ALTER TABLE issues ADD COLUMN project_id uuid;
ALTER TABLE issues ADD COLUMN cycle_id uuid;
ALTER TABLE issues ADD CONSTRAINT issues_workspace_team_project_fkey
  FOREIGN KEY (workspace_id, team_id, project_id) REFERENCES projects(workspace_id, team_id, id) ON DELETE RESTRICT;
ALTER TABLE issues ADD CONSTRAINT issues_workspace_team_cycle_fkey
  FOREIGN KEY (workspace_id, team_id, cycle_id) REFERENCES cycles(workspace_id, team_id, id) ON DELETE RESTRICT;
CREATE INDEX issues_team_project_idx ON issues(workspace_id, team_id, project_id);
CREATE INDEX issues_team_cycle_idx ON issues(workspace_id, team_id, cycle_id);
