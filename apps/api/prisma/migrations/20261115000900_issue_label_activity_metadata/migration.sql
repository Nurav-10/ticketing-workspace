BEGIN;

-- Preserve all existing event validation and add identifier-only label metadata.
ALTER FUNCTION issue_activity_metadata_is_safe(issue_activity_kind, jsonb)
  RENAME TO issue_activity_legacy_metadata_is_safe;

CREATE FUNCTION issue_activity_metadata_is_safe(event_kind issue_activity_kind, metadata jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $function$
DECLARE
  field text;
  value jsonb;
  identifier text;
  seen text[] := ARRAY[]::text[];
  total integer := 0;
BEGIN
  IF event_kind::text <> 'labels_changed' THEN
    RETURN issue_activity_legacy_metadata_is_safe(event_kind, metadata);
  END IF;
  IF jsonb_typeof(metadata) <> 'object'
    OR issue_jsonb_object_size(metadata) <> 2
    OR NOT (metadata ?& ARRAY['addedLabelIds', 'removedLabelIds']) THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['addedLabelIds', 'removedLabelIds'] LOOP
    IF jsonb_typeof(metadata->field) <> 'array' THEN RETURN false; END IF;
    total := total + jsonb_array_length(metadata->field);
    IF total > 100 THEN RETURN false; END IF;
    FOR value IN SELECT element FROM jsonb_array_elements(metadata->field) AS entries(element) LOOP
      IF jsonb_typeof(value) <> 'string' THEN RETURN false; END IF;
      identifier := lower(value #>> '{}');
      IF identifier !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR identifier = ANY(seen) THEN RETURN false; END IF;
      seen := array_append(seen, identifier);
    END LOOP;
  END LOOP;
  RETURN total > 0;
END
$function$;

ALTER TABLE issue_activity_events DROP CONSTRAINT issue_activity_events_metadata_safe_check;
ALTER TABLE issue_activity_events ADD CONSTRAINT issue_activity_events_metadata_safe_check
  CHECK (issue_activity_metadata_is_safe(event_kind, metadata) IS TRUE);

COMMIT;
