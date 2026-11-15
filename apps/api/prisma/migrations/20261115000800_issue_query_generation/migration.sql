BEGIN;

-- A transactionally maintained generation lets page cursors detect changes
-- instead of silently traversing a reordered result set. This applies to old
-- application binaries as well as new writers.
ALTER TABLE teams ADD COLUMN issue_query_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT teams_issue_query_version_positive CHECK (issue_query_version > 0);

CREATE FUNCTION bump_team_issue_query_version()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  target_workspace uuid;
  target_team uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.workspace_id, OLD.team_id) IS DISTINCT FROM (NEW.workspace_id, NEW.team_id) THEN
    RAISE EXCEPTION 'issue query resources cannot move between teams'
      USING ERRCODE = '23514', CONSTRAINT = 'issue_query_team_scope_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    target_workspace := OLD.workspace_id;
    target_team := OLD.team_id;
  ELSE
    target_workspace := NEW.workspace_id;
    target_team := NEW.team_id;
  END IF;

  -- All affected tables are tenant-scoped; this runs in the writer's own
  -- transaction, so a failed mutation does not invalidate issued cursors.
  UPDATE teams SET issue_query_version = issue_query_version + 1
  WHERE workspace_id = target_workspace AND id = target_team;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER issues_bump_query_version
AFTER INSERT OR UPDATE OR DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION bump_team_issue_query_version();

CREATE TRIGGER issue_labels_bump_query_version
AFTER INSERT OR UPDATE OR DELETE ON issue_labels
FOR EACH ROW EXECUTE FUNCTION bump_team_issue_query_version();

CREATE TRIGGER labels_bump_query_version
AFTER INSERT OR UPDATE OR DELETE ON labels
FOR EACH ROW EXECUTE FUNCTION bump_team_issue_query_version();

CREATE TRIGGER workflow_statuses_bump_query_version
AFTER INSERT OR UPDATE OR DELETE ON workflow_statuses
FOR EACH ROW EXECUTE FUNCTION bump_team_issue_query_version();

CREATE TRIGGER workflow_transitions_bump_query_version
AFTER INSERT OR UPDATE OR DELETE ON workflow_transitions
FOR EACH ROW EXECUTE FUNCTION bump_team_issue_query_version();

COMMIT;
