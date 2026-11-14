BEGIN;

-- This is intentionally a preflight, not a repair. Refuse to enable the invariant
-- over legacy data that already has a workspace with zero or multiple owners.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT w.id
    FROM workspaces AS w
    LEFT JOIN workspace_memberships AS wm ON wm.workspace_id = w.id AND wm.role = 'owner'
    GROUP BY w.id
    HAVING count(wm.user_id) <> 1
  ) THEN
    RAISE EXCEPTION 'owner invariant migration preflight failed: every existing workspace must have exactly one owner'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_exactly_one_owner';
  END IF;
END
$preflight$;

-- The partial unique index workspace_single_owner remains the at-most-one guard.
-- These deferred constraint triggers enforce the at-least-one half against the
-- transaction's final state, allowing an owner transfer's intermediate updates.
CREATE FUNCTION enforce_workspace_has_owner_at_commit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  checked_workspace_id uuid;
  affected_workspace_ids uuid[];
  owner_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'workspaces' THEN
    IF TG_OP = 'DELETE' THEN
      affected_workspace_ids := ARRAY[OLD.id];
    ELSE
      affected_workspace_ids := ARRAY[NEW.id];
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      affected_workspace_ids := ARRAY[OLD.workspace_id];
    ELSIF TG_OP = 'UPDATE' THEN
      -- A move changes both workspaces, so validate the source as well as the destination.
      affected_workspace_ids := ARRAY[OLD.workspace_id, NEW.workspace_id];
    ELSE
      affected_workspace_ids := ARRAY[NEW.workspace_id];
    END IF;
  END IF;

  FOREACH checked_workspace_id IN ARRAY affected_workspace_ids LOOP
  -- Workspace deletion is not an application feature in this phase. This branch
  -- exists only so an intentional database-level cascade can finish cleanly.
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = checked_workspace_id) THEN
    CONTINUE;
  END IF;

  SELECT count(*) INTO owner_count
  FROM workspace_memberships
  WHERE workspace_id = checked_workspace_id AND role = 'owner';

  IF owner_count <> 1 THEN
    RAISE EXCEPTION 'workspace % must have exactly one owner at commit', checked_workspace_id
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_exactly_one_owner';
  END IF;
  END LOOP;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER workspace_insert_requires_owner
AFTER INSERT ON workspaces
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_has_owner_at_commit();

CREATE CONSTRAINT TRIGGER workspace_membership_change_requires_owner
AFTER INSERT OR UPDATE OR DELETE ON workspace_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_has_owner_at_commit();

COMMIT;
