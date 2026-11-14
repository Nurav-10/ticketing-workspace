import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Config } from '../config/config.js';

export function createPrismaClient(config: Config): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 5_000
  });
  return new PrismaClient({ adapter });
}
