import { spawnSync } from 'node:child_process';
import pg from 'pg';

const migrationName = '20261114000000_identity_workspaces_baseline';

function parseDevelopmentTarget(): string {
  const baselineUrl = process.env.BASELINE_DATABASE_URL;
  if (!baselineUrl) throw new Error('BASELINE_DATABASE_URL is required; baseline marking is never automatic.');
  if (process.env.NODE_ENV === 'production') throw new Error('Baseline marking is forbidden in production mode.');

  const target = new URL(baselineUrl);
  const database = decodeURIComponent(target.pathname.slice(1)).toLowerCase();
  const username = decodeURIComponent(target.username).toLowerCase();
  const host = target.hostname.toLowerCase();
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || host !== 'db' || (target.port || '5432') !== '5432' || database !== 'ticketing' || username !== 'ticketing') {
    throw new Error('Baseline target must be the Compose development service db:5432 using database and role ticketing.');
  }

  const configured = process.env.DATABASE_URL;
  if (!configured || new URL(configured).toString() !== target.toString()) {
    throw new Error('DATABASE_URL must explicitly match BASELINE_DATABASE_URL before baseline checks can run.');
  }
  const testUrl = process.env.TEST_DATABASE_URL;
  if (testUrl) {
    const test = new URL(testUrl);
    if (test.hostname.toLowerCase() === host && (test.port || '5432') === '5432' && decodeURIComponent(test.pathname.slice(1)).toLowerCase() === database) {
      throw new Error('Baseline target must not match TEST_DATABASE_URL.');
    }
  }
  return baselineUrl;
}

export async function verifyDevelopmentBaseline(): Promise<string> {
  const target = parseDevelopmentTarget();
  const env = { ...process.env, DATABASE_URL: target };
  const diff = spawnSync('bun', ['x', 'prisma', 'migrate', 'diff', '--exit-code', '--from-config-datasource', '--to-schema=prisma/baseline/schema.prisma'], {
    cwd: process.cwd(), env, encoding: 'utf8'
  });
  if (diff.error) throw diff.error;
  if (diff.status !== 0) {
    const details = `${diff.stdout ?? ''}${diff.stderr ?? ''}`.trim();
    throw new Error(`Prisma-supported schema equivalence check failed (exit ${diff.status}). ${details}`);
  }

  const pool = new pg.Pool({ connectionString: target, max: 1, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    const prismaHistory = await client.query<{ history_table: string | null }>(`SELECT to_regclass('public._prisma_migrations')::text AS history_table`);
    if (prismaHistory.rows[0]?.history_table) {
      throw new Error('A Prisma migration history already exists; automatic baseline marking is refused. Review its entries manually.');
    }
    const ledger = await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    if (ledger.rows.length !== 1 || ledger.rows[0]?.name !== '001_identity_workspaces.sql') {
      throw new Error('Legacy schema_migrations ledger does not contain exactly the expected initial SQL migration marker.');
    }
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE baseline_expected_check_definitions (
        email text, name text, slug text, role text, key text, visibility text,
        redeemed_at timestamptz, revoked_at timestamptz,
        CONSTRAINT users_email_nonempty CHECK (length(trim(email)) > 0),
        CONSTRAINT workspaces_name_nonempty CHECK (length(trim(name)) > 0),
        CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$' AND slug !~ '-$'),
        CONSTRAINT workspace_memberships_role_check CHECK (role IN ('owner', 'admin', 'member')),
        CONSTRAINT teams_name_nonempty CHECK (length(trim(name)) > 0),
        CONSTRAINT teams_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{1,7}$'),
        CONSTRAINT teams_visibility_check CHECK (visibility IN ('workspace', 'private')),
        CONSTRAINT invitations_role_check CHECK (role IN ('admin', 'member')),
        CONSTRAINT invitations_email_nonempty CHECK (length(trim(email)) > 0),
        CONSTRAINT invitations_single_use_state CHECK (NOT (redeemed_at IS NOT NULL AND revoked_at IS NOT NULL))
      ) ON COMMIT DROP;
      CREATE TEMP TABLE baseline_expected_owner_index (workspace_id uuid, role text) ON COMMIT DROP;
      CREATE UNIQUE INDEX baseline_expected_owner_index_idx ON baseline_expected_owner_index(workspace_id) WHERE role = 'owner';
      CREATE TEMP TABLE baseline_expected_email_index (workspace_id uuid, email text) ON COMMIT DROP;
      CREATE INDEX baseline_expected_email_index_idx ON baseline_expected_email_index(workspace_id, lower(email));
    `);
    const checks = await client.query<{ name: string; actual_definition: string | null; expected_definition: string }>(`
      SELECT expected.conname AS name,
             pg_get_constraintdef(actual.oid) AS actual_definition,
             pg_get_constraintdef(expected.oid) AS expected_definition
        FROM pg_constraint AS expected
        LEFT JOIN pg_constraint AS actual
          ON actual.conname = expected.conname
         AND actual.conrelid = to_regclass(format('%I.%I', current_schema(), CASE expected.conname
           WHEN 'users_email_nonempty' THEN 'users'
           WHEN 'workspaces_name_nonempty' THEN 'workspaces'
           WHEN 'workspaces_slug_format' THEN 'workspaces'
           WHEN 'workspace_memberships_role_check' THEN 'workspace_memberships'
           WHEN 'teams_name_nonempty' THEN 'teams'
           WHEN 'teams_key_format' THEN 'teams'
           WHEN 'teams_visibility_check' THEN 'teams'
           WHEN 'invitations_role_check' THEN 'invitations'
           WHEN 'invitations_email_nonempty' THEN 'invitations'
           WHEN 'invitations_single_use_state' THEN 'invitations'
         END
         ))
       WHERE expected.conrelid = 'pg_temp.baseline_expected_check_definitions'::regclass
    `);
    const expectedCheckNames = [
      'users_email_nonempty', 'workspaces_name_nonempty', 'workspaces_slug_format',
      'workspace_memberships_role_check', 'teams_name_nonempty', 'teams_key_format',
      'teams_visibility_check', 'invitations_role_check', 'invitations_email_nonempty',
      'invitations_single_use_state'
    ];
    const checkMap = new Map(checks.rows.map((row) => [row.name, row]));
    const checkMismatch = expectedCheckNames.filter((name) => {
      const row = checkMap.get(name);
      return !row?.actual_definition || row.actual_definition !== row.expected_definition;
    });
    const actualCheckCount = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_constraint
       WHERE contype = 'c' AND conrelid IN (
         'users'::regclass, 'workspaces'::regclass, 'workspace_memberships'::regclass,
         'teams'::regclass, 'invitations'::regclass
       )
    `);
    if (checkMismatch.length || actualCheckCount.rows[0]?.count !== expectedCheckNames.length) {
      throw new Error(`SQL CHECK constraints differ from the reviewed baseline: ${checkMismatch.join(', ') || 'unexpected constraint count'}.`);
    }
    const extension = await client.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS exists`);
    if (!extension.rows[0]?.exists) throw new Error('Required pgcrypto extension is missing.');

    const indexShapes = await client.query<{
      name: string; table_name: string; is_unique: boolean; is_valid: boolean; is_ready: boolean;
      key_count: number; attribute_count: number; access_method: string; predicate: string | null;
      first_key: string | null; second_key: string | null; definition: string;
    }>(`
      SELECT idx.relname AS name, tbl.relname AS table_name, i.indisunique AS is_unique,
             i.indisvalid AS is_valid, i.indisready AS is_ready,
             i.indnkeyatts AS key_count, i.indnatts AS attribute_count,
             am.amname AS access_method, pg_get_expr(i.indpred, i.indrelid) AS predicate,
             pg_get_indexdef(i.indexrelid, 1, true) AS first_key,
             CASE WHEN i.indnkeyatts > 1 THEN pg_get_indexdef(i.indexrelid, 2, true) END AS second_key,
             pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index AS i
        JOIN pg_class AS idx ON idx.oid = i.indexrelid
        JOIN pg_class AS tbl ON tbl.oid = i.indrelid
        JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
        JOIN pg_am AS am ON am.oid = idx.relam
       WHERE (ns.nspname = current_schema() AND idx.relname IN ('workspace_single_owner', 'invitations_workspace_email'))
          OR (ns.oid = pg_my_temp_schema() AND idx.relname IN ('baseline_expected_owner_index_idx', 'baseline_expected_email_index_idx'))
    `);
    const indexByName = new Map(indexShapes.rows.map((row) => [row.name, row]));
    const expectedOwnerIndex = indexByName.get('baseline_expected_owner_index_idx');
    const actualOwnerIndex = indexByName.get('workspace_single_owner');
    const expectedEmailIndex = indexByName.get('baseline_expected_email_index_idx');
    const actualEmailIndex = indexByName.get('invitations_workspace_email');
    const definitionBody = (definition: string) => definition.slice(definition.indexOf(' USING '));
    const indexMismatch = (actual: typeof expectedOwnerIndex, expected: typeof expectedOwnerIndex, actualTable: string, expectedTable: string) =>
      !actual || !expected || actual.table_name !== actualTable || expected.table_name !== expectedTable ||
      actual.is_unique !== expected.is_unique || actual.is_valid !== expected.is_valid || actual.is_ready !== expected.is_ready ||
      actual.key_count !== expected.key_count || actual.attribute_count !== expected.attribute_count ||
      actual.access_method !== expected.access_method || actual.predicate !== expected.predicate ||
      actual.first_key !== expected.first_key || actual.second_key !== expected.second_key ||
      definitionBody(actual.definition) !== definitionBody(expected.definition);
    if (indexMismatch(actualOwnerIndex, expectedOwnerIndex, 'workspace_memberships', 'baseline_expected_owner_index') ||
        indexMismatch(actualEmailIndex, expectedEmailIndex, 'invitations', 'baseline_expected_email_index')) {
      throw new Error('SQL-only indexes do not exactly match the reviewed partial-owner and invitation-email definitions.');
    }
    const unsupportedIndexes = await client.query<{ name: string }>(`
      SELECT idx.relname AS name FROM pg_index AS i
      JOIN pg_class AS idx ON idx.oid = i.indexrelid
      WHERE i.indrelid IN (
          'users'::regclass, 'workspaces'::regclass, 'workspace_memberships'::regclass,
          'teams'::regclass, 'invitations'::regclass
        )
        AND (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL)
        AND idx.relname NOT IN ('workspace_single_owner', 'invitations_workspace_email')
    `);
    if (unsupportedIndexes.rows.length) throw new Error('Unexpected SQL-only partial or expression indexes exist.');

    return target;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

export function markDevelopmentBaseline(target: string): void {
  const result = spawnSync('bun', ['x', 'prisma', 'migrate', 'resolve', '--applied', migrationName], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: target }, encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Prisma baseline marker failed (exit ${result.status}). ${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
}
