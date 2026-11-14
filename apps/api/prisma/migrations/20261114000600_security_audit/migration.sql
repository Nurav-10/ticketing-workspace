BEGIN;

CREATE TYPE security_audit_event_kind AS ENUM (
  'workspace_invitation_created',
  'workspace_invitation_revoked',
  'workspace_invitation_redeemed',
  'workspace_membership_added',
  'workspace_membership_removed',
  'workspace_membership_role_changed',
  'workspace_owner_transferred',
  'team_created',
  'team_updated',
  'team_deleted',
  'team_membership_added',
  'team_membership_removed'
);

CREATE FUNCTION security_audit_object_size(value jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE WHEN jsonb_typeof(value) = 'object'
    THEN (SELECT count(*) FROM jsonb_object_keys(value))
    ELSE -1 END
$function$;

CREATE FUNCTION security_audit_metadata_is_valid(
  event_kind security_audit_event_kind,
  metadata jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE event_kind
    WHEN 'workspace_invitation_created' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 1
      AND metadata ? 'invitation_id'
      AND metadata ->> 'invitation_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'workspace_invitation_revoked' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 1
      AND metadata ? 'invitation_id'
      AND metadata ->> 'invitation_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'workspace_invitation_redeemed' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 1
      AND metadata ? 'invitation_id'
      AND metadata ->> 'invitation_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'workspace_membership_added' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 2
      AND metadata ?& ARRAY['target_user_id', 'role_after']
      AND metadata ->> 'target_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND metadata ->> 'role_after' IN ('owner', 'admin', 'member')
    WHEN 'workspace_membership_removed' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 2
      AND metadata ?& ARRAY['target_user_id', 'role_before']
      AND metadata ->> 'target_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND metadata ->> 'role_before' IN ('owner', 'admin', 'member')
    WHEN 'workspace_membership_role_changed' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 3
      AND metadata ?& ARRAY['target_user_id', 'role_before', 'role_after']
      AND metadata ->> 'target_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND metadata ->> 'role_before' IN ('owner', 'admin', 'member')
      AND metadata ->> 'role_after' IN ('owner', 'admin', 'member')
      AND metadata ->> 'role_before' <> metadata ->> 'role_after'
    WHEN 'workspace_owner_transferred' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 2
      AND metadata ?& ARRAY['previous_owner_user_id', 'new_owner_user_id']
      AND metadata ->> 'previous_owner_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND metadata ->> 'new_owner_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND metadata ->> 'previous_owner_user_id' <> metadata ->> 'new_owner_user_id'
    WHEN 'team_created' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 1
      AND metadata ? 'team_id'
      AND metadata ->> 'team_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'team_updated' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 1
      AND metadata ? 'team_id'
      AND metadata ->> 'team_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'team_deleted' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 1
      AND metadata ? 'team_id'
      AND metadata ->> 'team_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'team_membership_added' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 2
      AND metadata ?& ARRAY['team_id', 'target_user_id']
      AND metadata ->> 'team_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND metadata ->> 'target_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'team_membership_removed' THEN
      jsonb_typeof(metadata) = 'object'
      AND security_audit_object_size(metadata) = 2
      AND metadata ?& ARRAY['team_id', 'target_user_id']
      AND metadata ->> 'team_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND metadata ->> 'target_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ELSE false
  END
$function$;

CREATE TABLE security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  actor_user_id uuid,
  event_kind security_audit_event_kind NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT security_audit_events_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT security_audit_events_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT security_audit_events_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT security_audit_events_metadata_allowlist_check
    CHECK (security_audit_metadata_is_valid(event_kind, metadata) IS TRUE)
);

CREATE INDEX security_audit_events_workspace_created_at_idx
  ON security_audit_events (workspace_id, created_at DESC);
CREATE INDEX security_audit_events_actor_created_at_idx
  ON security_audit_events (actor_user_id, created_at DESC);

CREATE FUNCTION security_audit_prepare_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1
  FROM workspaces
  WHERE id = NEW.workspace_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'security audit workspace does not exist'
      USING ERRCODE = '23503', CONSTRAINT = 'security_audit_events_workspace_id_fkey';
  END IF;

  IF NEW.actor_user_id IS NOT NULL THEN
    PERFORM 1
    FROM workspace_memberships
    WHERE workspace_id = NEW.workspace_id AND user_id = NEW.actor_user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'security audit actor is not a member of the workspace'
        USING ERRCODE = '23514', CONSTRAINT = 'security_audit_actor_workspace_membership_check';
    END IF;
  END IF;

  -- Ignore caller-supplied timestamps so the server database clock is authoritative.
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER security_audit_prepare_insert_trigger
BEFORE INSERT ON security_audit_events
FOR EACH ROW EXECUTE FUNCTION security_audit_prepare_insert();

CREATE FUNCTION security_audit_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'security audit events are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'security_audit_events_append_only';
END
$function$;

CREATE TRIGGER security_audit_events_reject_row_mutation
BEFORE UPDATE OR DELETE ON security_audit_events
FOR EACH ROW EXECUTE FUNCTION security_audit_reject_mutation();

CREATE TRIGGER security_audit_events_reject_truncate
BEFORE TRUNCATE ON security_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION security_audit_reject_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE security_audit_events FROM PUBLIC;

COMMIT;
