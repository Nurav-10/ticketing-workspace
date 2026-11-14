CREATE TABLE login_transactions (
  handle_hash BYTEA PRIMARY KEY,
  encrypted_payload BYTEA NOT NULL,
  encryption_iv BYTEA NOT NULL,
  authentication_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT login_transactions_handle_hash_length CHECK (octet_length(handle_hash) = 32),
  CONSTRAINT login_transactions_payload_nonempty CHECK (octet_length(encrypted_payload) > 0),
  CONSTRAINT login_transactions_iv_length CHECK (octet_length(encryption_iv) = 12),
  CONSTRAINT login_transactions_auth_tag_length CHECK (octet_length(authentication_tag) = 16),
  CONSTRAINT login_transactions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX login_transactions_expires_at_idx ON login_transactions(expires_at);
