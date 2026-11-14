CREATE TABLE rate_limit_counters (
  operation text NOT NULL,
  identifier_hash bytea NOT NULL,
  window_start timestamptz(3) NOT NULL,
  window_ms integer NOT NULL,
  hit_count bigint NOT NULL DEFAULT 1,
  expires_at timestamptz(6) NOT NULL,
  CONSTRAINT rate_limit_counters_pkey PRIMARY KEY (operation, identifier_hash, window_start, window_ms),
  CONSTRAINT rate_limit_counters_operation_check CHECK (operation ~ '^[a-z][a-z0-9._-]{0,63}$'),
  CONSTRAINT rate_limit_counters_hash_check CHECK (octet_length(identifier_hash) = 32),
  CONSTRAINT rate_limit_counters_window_ms_check CHECK (window_ms BETWEEN 1000 AND 86400000),
  CONSTRAINT rate_limit_counters_hit_count_check CHECK (hit_count > 0),
  CONSTRAINT rate_limit_counters_expiry_check CHECK (expires_at > window_start)
);

CREATE INDEX rate_limit_counters_expires_at_idx ON rate_limit_counters(expires_at);
