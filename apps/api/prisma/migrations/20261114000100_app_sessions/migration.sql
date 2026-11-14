ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'));

CREATE TABLE app_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  created_at timestamptz(6) NOT NULL,
  last_seen_at timestamptz(6) NOT NULL,
  idle_expires_at timestamptz(6) NOT NULL,
  absolute_expires_at timestamptz(6) NOT NULL,
  revoked_at timestamptz(6),
  revoke_reason text,
  CONSTRAINT app_sessions_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT app_sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT app_sessions_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT app_sessions_lifecycle CHECK (
    created_at <= last_seen_at
    AND created_at < idle_expires_at
    AND created_at < absolute_expires_at
    AND idle_expires_at <= absolute_expires_at
  )
);

CREATE INDEX app_sessions_user_id_idx ON app_sessions(user_id);
CREATE INDEX app_sessions_expiry_cleanup_idx ON app_sessions(idle_expires_at)
  WHERE revoked_at IS NULL;
