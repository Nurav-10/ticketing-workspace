import pg from 'pg';
import type { Config } from '../config/config.js';

export function createPool(config: Config): pg.Pool {
  return new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, application_name: 'ticketing-api' });
}
