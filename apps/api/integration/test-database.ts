import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is required for integration tests; refusing to fall back to DATABASE_URL.');
}
if (process.env.NODE_ENV === 'production') throw new Error('Integration tests refuse to run with NODE_ENV=production.');

const testUrl = new URL(connectionString);
const databaseName = decodeURIComponent(testUrl.pathname.replace(/^\//, '')).toLowerCase();
const username = decodeURIComponent(testUrl.username).toLowerCase();
const hostname = testUrl.hostname.toLowerCase();
const effectivePort = testUrl.port || '5432';
if (!['postgres:', 'postgresql:'].includes(testUrl.protocol) || hostname !== 'db-test' || effectivePort !== '5432' || databaseName !== 'ticketing_test' || username !== 'ticketing_test') {
  throw new Error('TEST_DATABASE_URL must target the project Compose service db-test:5432 using database and role ticketing_test.');
}
if (process.env.DATABASE_URL) {
  const developmentUrl = new URL(process.env.DATABASE_URL);
  const developmentHost = developmentUrl.hostname.toLowerCase();
  const developmentPort = developmentUrl.port || (['postgres:', 'postgresql:'].includes(developmentUrl.protocol) ? '5432' : '');
  const developmentDatabase = decodeURIComponent(developmentUrl.pathname.replace(/^\//, '')).toLowerCase();
  const sameTarget = developmentHost === hostname && developmentPort === effectivePort && developmentDatabase === databaseName;
  if (sameTarget) throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL.');
}

const apiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const migration = spawnSync('bun', ['x', 'prisma', 'migrate', 'deploy'], {
  cwd: apiDirectory,
  env: { ...process.env, DATABASE_URL: connectionString },
  encoding: 'utf8'
});
if (migration.error) throw migration.error;
if (migration.status !== 0) {
  throw new Error(`Prisma migrations could not be deployed to the guarded test database (exit ${migration.status}). ${migration.stdout ?? ''}${migration.stderr ?? ''}`);
}

export const pool = new pg.Pool({ connectionString, max: 12, application_name: 'ticketing-api-integration-tests' });
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 12 }) });

/**
 * Removes append-only audit rows for disposable integration fixtures. This is
 * safe only because the connection target above is hard-guarded to db-test.
 */
export async function removeTestAuditEvents(workspaceIds: readonly string[]): Promise<void> {
  if (workspaceIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query('DELETE FROM security_audit_events WHERE workspace_id = ANY($1::uuid[])', [workspaceIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
