import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from '../src/db/run-migrations.js';

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

export const pool = new pg.Pool({ connectionString, max: 12, application_name: 'ticketing-api-integration-tests' });
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
await applyMigrations(pool, migrationsDirectory);
