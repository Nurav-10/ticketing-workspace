-- Phase 4: Workflows and configurable statuses migration
-- Additive expand migration:
-- 1. Create workflow_status_category enum
-- 2. Add workflow_version column to teams
-- 3. Create workflow_statuses table and constraints
-- 4. Create workflow_transitions table and constraints
-- 5. Add workflow_status_id column to issues and foreign key
-- 6. Trigger to automatically seed 5 default workflow statuses and transitions when a team is inserted
-- 7. Backfill existing teams with default workflow statuses and transitions
-- 8. Backfill existing issues to populate workflow_status_id from status

BEGIN;

CREATE TYPE workflow_status_category AS ENUM ('backlog', 'unstarted', 'started', 'completed', 'canceled');

ALTER TABLE teams ADD COLUMN workflow_version integer NOT NULL DEFAULT 1;
ALTER TABLE teams ADD CONSTRAINT teams_workflow_version_positive CHECK (workflow_version >= 1);

CREATE TABLE workflow_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  key varchar(64) NOT NULL,
  name varchar(100) NOT NULL,
  category workflow_status_category NOT NULL,
  position integer NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_retired boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_statuses_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workflow_statuses_workspace_id_team_id_fkey FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_statuses_team_id_key_key UNIQUE (team_id, key),
  CONSTRAINT workflow_statuses_workspace_id_team_id_id_key UNIQUE (workspace_id, team_id, id),
  CONSTRAINT workflow_statuses_position_non_negative CHECK (position >= 0),
  CONSTRAINT workflow_statuses_key_format CHECK (key ~ '^[a-z0-9_-]{1,64}$'),
  CONSTRAINT workflow_statuses_name_not_empty CHECK (length(trim(name)) > 0),
  CONSTRAINT workflow_statuses_retired_not_default CHECK (NOT (is_retired AND is_default))
);

CREATE UNIQUE INDEX workflow_statuses_team_position_active_idx ON workflow_statuses (team_id, position) WHERE is_retired = false;
CREATE INDEX workflow_statuses_team_retired_position_idx ON workflow_statuses (workspace_id, team_id, is_retired, position);

CREATE TABLE workflow_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  source_status_id uuid NOT NULL,
  target_status_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_transitions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workflow_transitions_workspace_id_team_id_fkey FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_transitions_source_status_fkey FOREIGN KEY (workspace_id, team_id, source_status_id) REFERENCES workflow_statuses(workspace_id, team_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_transitions_target_status_fkey FOREIGN KEY (workspace_id, team_id, target_status_id) REFERENCES workflow_statuses(workspace_id, team_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_transitions_no_self_loop CHECK (source_status_id <> target_status_id),
  CONSTRAINT workflow_transitions_team_source_target_key UNIQUE (team_id, source_status_id, target_status_id)
);

CREATE INDEX workflow_transitions_team_source_idx ON workflow_transitions (team_id, source_status_id);

ALTER TABLE issues ADD COLUMN workflow_status_id uuid;
ALTER TABLE issues ADD CONSTRAINT issues_workspace_id_team_id_workflow_status_id_fkey FOREIGN KEY (workspace_id, team_id, workflow_status_id) REFERENCES workflow_statuses(workspace_id, team_id, id) ON DELETE RESTRICT;
CREATE INDEX issues_team_workflow_status_idx ON issues (workspace_id, team_id, workflow_status_id);

-- Trigger function to automatically seed default statuses and transitions when a team is created
CREATE OR REPLACE FUNCTION seed_default_team_workflow_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_backlog_id uuid := gen_random_uuid();
  v_todo_id uuid := gen_random_uuid();
  v_in_progress_id uuid := gen_random_uuid();
  v_done_id uuid := gen_random_uuid();
  v_canceled_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO workflow_statuses(id, workspace_id, team_id, key, name, category, position, is_default, is_retired)
  VALUES
    (v_backlog_id, NEW.workspace_id, NEW.id, 'backlog', 'Backlog', 'backlog'::workflow_status_category, 0, true, false),
    (v_todo_id, NEW.workspace_id, NEW.id, 'todo', 'Todo', 'unstarted'::workflow_status_category, 1, false, false),
    (v_in_progress_id, NEW.workspace_id, NEW.id, 'in_progress', 'In Progress', 'started'::workflow_status_category, 2, false, false),
    (v_done_id, NEW.workspace_id, NEW.id, 'done', 'Done', 'completed'::workflow_status_category, 3, false, false),
    (v_canceled_id, NEW.workspace_id, NEW.id, 'canceled', 'Canceled', 'canceled'::workflow_status_category, 4, false, false)
  ON CONFLICT (team_id, key) DO NOTHING;

  -- Resolve actual IDs if already present
  SELECT id INTO v_backlog_id FROM workflow_statuses WHERE team_id = NEW.id AND key = 'backlog';
  SELECT id INTO v_todo_id FROM workflow_statuses WHERE team_id = NEW.id AND key = 'todo';
  SELECT id INTO v_in_progress_id FROM workflow_statuses WHERE team_id = NEW.id AND key = 'in_progress';
  SELECT id INTO v_done_id FROM workflow_statuses WHERE team_id = NEW.id AND key = 'done';
  SELECT id INTO v_canceled_id FROM workflow_statuses WHERE team_id = NEW.id AND key = 'canceled';

  INSERT INTO workflow_transitions(workspace_id, team_id, source_status_id, target_status_id)
  VALUES
    (NEW.workspace_id, NEW.id, v_backlog_id, v_todo_id),
    (NEW.workspace_id, NEW.id, v_backlog_id, v_canceled_id),
    (NEW.workspace_id, NEW.id, v_todo_id, v_backlog_id),
    (NEW.workspace_id, NEW.id, v_todo_id, v_in_progress_id),
    (NEW.workspace_id, NEW.id, v_todo_id, v_canceled_id),
    (NEW.workspace_id, NEW.id, v_in_progress_id, v_todo_id),
    (NEW.workspace_id, NEW.id, v_in_progress_id, v_done_id),
    (NEW.workspace_id, NEW.id, v_in_progress_id, v_canceled_id),
    (NEW.workspace_id, NEW.id, v_done_id, v_todo_id),
    (NEW.workspace_id, NEW.id, v_canceled_id, v_backlog_id),
    (NEW.workspace_id, NEW.id, v_canceled_id, v_todo_id)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_seed_team_workflow
AFTER INSERT ON teams
FOR EACH ROW
EXECUTE FUNCTION seed_default_team_workflow_trigger();

-- Backfill existing teams with default statuses and transitions
DO $$
DECLARE
  t RECORD;
  v_backlog_id uuid;
  v_todo_id uuid;
  v_in_progress_id uuid;
  v_done_id uuid;
  v_canceled_id uuid;
BEGIN
  FOR t IN SELECT id, workspace_id FROM teams LOOP
    v_backlog_id := gen_random_uuid();
    v_todo_id := gen_random_uuid();
    v_in_progress_id := gen_random_uuid();
    v_done_id := gen_random_uuid();
    v_canceled_id := gen_random_uuid();

    INSERT INTO workflow_statuses(id, workspace_id, team_id, key, name, category, position, is_default, is_retired)
    VALUES
      (v_backlog_id, t.workspace_id, t.id, 'backlog', 'Backlog', 'backlog'::workflow_status_category, 0, true, false),
      (v_todo_id, t.workspace_id, t.id, 'todo', 'Todo', 'unstarted'::workflow_status_category, 1, false, false),
      (v_in_progress_id, t.workspace_id, t.id, 'in_progress', 'In Progress', 'started'::workflow_status_category, 2, false, false),
      (v_done_id, t.workspace_id, t.id, 'done', 'Done', 'completed'::workflow_status_category, 3, false, false),
      (v_canceled_id, t.workspace_id, t.id, 'canceled', 'Canceled', 'canceled'::workflow_status_category, 4, false, false)
    ON CONFLICT (team_id, key) DO NOTHING;

    SELECT id INTO v_backlog_id FROM workflow_statuses WHERE team_id = t.id AND key = 'backlog';
    SELECT id INTO v_todo_id FROM workflow_statuses WHERE team_id = t.id AND key = 'todo';
    SELECT id INTO v_in_progress_id FROM workflow_statuses WHERE team_id = t.id AND key = 'in_progress';
    SELECT id INTO v_done_id FROM workflow_statuses WHERE team_id = t.id AND key = 'done';
    SELECT id INTO v_canceled_id FROM workflow_statuses WHERE team_id = t.id AND key = 'canceled';

    INSERT INTO workflow_transitions(workspace_id, team_id, source_status_id, target_status_id)
    VALUES
      (t.workspace_id, t.id, v_backlog_id, v_todo_id),
      (t.workspace_id, t.id, v_backlog_id, v_canceled_id),
      (t.workspace_id, t.id, v_todo_id, v_backlog_id),
      (t.workspace_id, t.id, v_todo_id, v_in_progress_id),
      (t.workspace_id, t.id, v_todo_id, v_canceled_id),
      (t.workspace_id, t.id, v_in_progress_id, v_todo_id),
      (t.workspace_id, t.id, v_in_progress_id, v_done_id),
      (t.workspace_id, t.id, v_in_progress_id, v_canceled_id),
      (t.workspace_id, t.id, v_done_id, v_todo_id),
      (t.workspace_id, t.id, v_canceled_id, v_backlog_id),
      (t.workspace_id, t.id, v_canceled_id, v_todo_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

-- Backfill existing issues to populate workflow_status_id
UPDATE issues i
SET workflow_status_id = ws.id
FROM workflow_statuses ws
WHERE ws.team_id = i.team_id AND ws.key = i.status::text
  AND i.workflow_status_id IS NULL;

COMMIT;
