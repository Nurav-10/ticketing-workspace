export interface IncrementRateLimitBucket {
  operation: string;
  identifierHash: Buffer;
  windowMs: number;
  retentionMs: number;
}

export interface RateLimitBucketObservation {
  hitCount: bigint;
  windowStartsAt: Date;
  windowEndsAt: Date;
  databaseNow: Date;
}

export interface RateLimitRepository {
  /** One database statement must calculate DB time and atomically insert/increment. */
  increment(input: IncrementRateLimitBucket): Promise<RateLimitBucketObservation>;
  /** Delete only rows whose retention has elapsed according to database time. */
  deleteExpired(batchSize: number): Promise<number>;
}
