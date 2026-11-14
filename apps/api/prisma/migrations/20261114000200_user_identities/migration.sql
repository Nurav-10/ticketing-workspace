-- Preserve each legacy value verbatim. Its original issuer is unknown, so do not backfill it.
ALTER TABLE users ALTER COLUMN provider_subject DROP NOT NULL;

CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  issuer text COLLATE "C" NOT NULL,
  subject text COLLATE "C" NOT NULL,
  provider_email text,
  provider_email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT user_identities_issuer_subject_key UNIQUE (issuer, subject),
  CONSTRAINT user_identities_issuer_check CHECK (
    issuer LIKE 'https://%' AND issuer <> 'https://'
  ),
  CONSTRAINT user_identities_subject_check CHECK (subject <> ''),
  CONSTRAINT user_identities_provider_email_check CHECK (
    provider_email IS NOT NULL OR provider_email_verified = false
  )
);

CREATE INDEX user_identities_user_id_idx ON user_identities(user_id);
