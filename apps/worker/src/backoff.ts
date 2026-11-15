export interface BackoffPolicyConfig {
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  factor?: number | undefined;
  maxRetries?: number | undefined;
  jitterFactor?: number | undefined;
}

/**
 * Calculates exponential retry backoff intervals with jitter and enforces dead-letter threshold.
 */
export class BackoffPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  readonly maxRetries: number;
  readonly jitterFactor: number;

  constructor(config: BackoffPolicyConfig = {}) {
    this.initialDelayMs = config.initialDelayMs ?? 1_000;
    this.maxDelayMs = config.maxDelayMs ?? 3_600_000;
    this.factor = config.factor ?? 2;
    this.maxRetries = config.maxRetries ?? 5;
    this.jitterFactor = config.jitterFactor ?? 0;
  }

  /**
   * Calculates next attempt time or indicates dead-letter transition when retries are exhausted.
   * currentRetryCount is the number of attempts already failed.
   */
  calculateNextAttempt(
    currentRetryCount: number,
    now: Date = new Date(),
  ): { nextAttemptAt: Date; deadLetter: boolean } {
    const nextRetry = currentRetryCount + 1;
    if (nextRetry > this.maxRetries) {
      return { nextAttemptAt: now, deadLetter: true };
    }

    let delay = this.initialDelayMs * Math.pow(this.factor, currentRetryCount);
    if (delay > this.maxDelayMs) {
      delay = this.maxDelayMs;
    }

    if (this.jitterFactor > 0) {
      const delta = (Math.random() * 2 - 1) * this.jitterFactor * delay;
      delay = Math.max(0, delay + delta);
    }

    return {
      nextAttemptAt: new Date(now.getTime() + Math.round(delay)),
      deadLetter: false,
    };
  }
}
