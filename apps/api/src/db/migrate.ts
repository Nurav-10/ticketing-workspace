import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/config.js';
import { createPool } from './pool.js';
import { applyMigrations } from './run-migrations.js';

const moduleMigrations = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const sourceFromCompiledModule = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'db', 'migrations');
const sourceFromWorkingDirectory = join(process.cwd(), 'src', 'db', 'migrations');
let directory = moduleMigrations;
try { await readdir(directory); } catch {
  directory = sourceFromCompiledModule;
  try { await readdir(directory); } catch { directory = sourceFromWorkingDirectory; }
}
const pool = createPool(loadConfig());
try {
  await applyMigrations(pool, directory);
} finally { await pool.end(); }
