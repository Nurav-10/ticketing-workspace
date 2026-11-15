-- Derived search text stays in PostgreSQL and is updated atomically whenever
-- issue text changes. Search uses the simple configuration (no stemming).
-- This generated-column rewrite and index build require an operational
-- maintenance window and a verified backup on existing large databases.
ALTER TABLE issues ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('pg_catalog.simple'::regconfig, title), 'A') ||
  setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(description, '')), 'B')
) STORED;

CREATE INDEX issues_search_vector_gin_idx ON issues USING gin(search_vector);
