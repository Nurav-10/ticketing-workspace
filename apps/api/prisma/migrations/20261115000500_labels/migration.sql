BEGIN;

CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  name varchar(50) NOT NULL,
  normalized_name varchar(50) NOT NULL,
  color varchar(7) NOT NULL DEFAULT '#6b7280',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT labels_workspace_id_team_id_fkey
    FOREIGN KEY (workspace_id, team_id)
    REFERENCES teams(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT labels_name_safe_check CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 50
    AND name ~ '^[A-Za-z0-9][A-Za-z0-9 _-]*$'
  ),
  CONSTRAINT labels_normalized_name_check CHECK (
    normalized_name = lower(btrim(name))
  ),
  CONSTRAINT labels_color_hex_check CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT labels_version_positive_check CHECK (version > 0)
);

CREATE UNIQUE INDEX labels_workspace_id_team_id_id_key
  ON labels (workspace_id, team_id, id);
CREATE UNIQUE INDEX labels_workspace_id_team_id_normalized_name_key
  ON labels (workspace_id, team_id, normalized_name);
CREATE INDEX labels_team_created_idx
  ON labels (workspace_id, team_id, created_at DESC, id DESC);

CREATE TABLE issue_labels (
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  label_id uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT issue_labels_pkey PRIMARY KEY (workspace_id, team_id, issue_id, label_id),
  CONSTRAINT issue_labels_workspace_id_team_id_issue_id_fkey
    FOREIGN KEY (workspace_id, team_id, issue_id)
    REFERENCES issues(workspace_id, team_id, id) ON DELETE CASCADE,
  CONSTRAINT issue_labels_workspace_id_team_id_label_id_fkey
    FOREIGN KEY (workspace_id, team_id, label_id)
    REFERENCES labels(workspace_id, team_id, id) ON DELETE RESTRICT
);

CREATE INDEX issue_labels_label_lookup_idx
  ON issue_labels (workspace_id, team_id, label_id, issue_id);

COMMIT;
