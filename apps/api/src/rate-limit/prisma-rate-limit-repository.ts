import type { PrismaClient } from '../generated/prisma/client.js';
import type { IncrementRateLimitBucket, RateLimitBucketObservation, RateLimitRepository } from './rate-limit-repository.js';

interface CounterRow extends RateLimitBucketObservation {}

interface ExpiredCounterKey {
  operation: string;
  identifierHash: Uint8Array<ArrayBuffer>;
  windowStart: Date;
  windowMs: number;
}

const maximumCleanupBatchSize = 5_000;
const maximumWindowRetries = 3;

export class PrismaRateLimitRepository implements RateLimitRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async increment(input: IncrementRateLimitBucket): Promise<RateLimitBucketObservation> {
    const identifierHash = Uint8Array.from(input.identifierHash);
    // A conflict can wait behind another instance's row lock. If that wait crosses
    // the fixed-window boundary, charge the stale bucket and then conservatively
    // charge the new one. Return a decision only for a bucket current at observation.
    for (let attempt = 0; attempt < maximumWindowRetries; attempt++) {
      const rows = await this.prisma.$queryRaw<CounterRow[]>`
        WITH db_clock AS MATERIALIZED (
          SELECT clock_timestamp() AS now
        ), bucket AS (
          SELECT now,
                 floor(extract(epoch FROM now) * 1000 / ${input.windowMs}) * ${input.windowMs} AS start_ms
          FROM db_clock
        ), upserted AS (
          INSERT INTO rate_limit_counters
            (operation, identifier_hash, window_start, window_ms, hit_count, expires_at)
          SELECT ${input.operation}, ${identifierHash},
                 to_timestamp(start_ms / 1000.0)::timestamptz(3),
                 ${input.windowMs}, 1,
                 to_timestamp((start_ms + ${input.windowMs} + ${input.retentionMs}) / 1000.0)
          FROM bucket
          ON CONFLICT (operation, identifier_hash, window_start, window_ms)
          DO UPDATE SET hit_count = rate_limit_counters.hit_count + 1,
                        expires_at = EXCLUDED.expires_at
          RETURNING hit_count, window_start, window_ms
        )
        SELECT upserted.hit_count AS "hitCount",
               upserted.window_start AS "windowStartsAt",
               upserted.window_start + (upserted.window_ms * interval '1 millisecond') AS "windowEndsAt",
               clock_timestamp() AS "databaseNow"
        FROM upserted
      `;
      const row = rows[0];
      if (!row) throw new Error('Rate-limit counter update returned no result');
      if (row.windowStartsAt <= row.databaseNow && row.databaseNow < row.windowEndsAt) return row;
    }
    throw new Error('Rate-limit counter update repeatedly crossed a database window boundary');
  }

  async deleteExpired(batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximumCleanupBatchSize) {
      throw new Error(`Rate-limit cleanup batch size must be between 1 and ${maximumCleanupBatchSize}`);
    }
    const clock = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = clock[0]?.now;
    if (!now) throw new Error('Database clock unavailable for rate-limit cleanup');

    const candidates = await this.prisma.rateLimitCounter.findMany({
      where: { expiresAt: { lte: now } },
      select: { operation: true, identifierHash: true, windowStart: true, windowMs: true },
      orderBy: [
        { expiresAt: 'asc' },
        { operation: 'asc' },
        { identifierHash: 'asc' },
        { windowStart: 'asc' },
        { windowMs: 'asc' },
      ],
      take: batchSize,
    }) as ExpiredCounterKey[];
    if (candidates.length === 0) return 0;

    const result = await this.prisma.rateLimitCounter.deleteMany({
      where: {
        expiresAt: { lte: now },
        OR: candidates.map((candidate) => ({
          operation: candidate.operation,
          identifierHash: candidate.identifierHash,
          windowStart: candidate.windowStart,
          windowMs: candidate.windowMs,
        })),
      },
    });
    return result.count;
  }
}
