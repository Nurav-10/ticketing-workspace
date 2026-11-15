import type { EventHandler, EventHandlerContext } from './outbox-types.js';

/**
 * Storage contract for deduplicating at-least-once deliveries.
 */
export interface IdempotencyStore {
  hasProcessed(eventId: string, consumerGroup?: string): Promise<boolean>;
  markProcessed(eventId: string, consumerGroup?: string, ttlMs?: number): Promise<void>;
}

/**
 * In-memory idempotency store with TTL eviction.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, number>();

  private key(eventId: string, consumerGroup = 'default'): string {
    return `${consumerGroup}:${eventId}`;
  }

  async hasProcessed(eventId: string, consumerGroup = 'default'): Promise<boolean> {
    const expiresAt = this.records.get(this.key(eventId, consumerGroup));
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      this.records.delete(this.key(eventId, consumerGroup));
      return false;
    }
    return true;
  }

  async markProcessed(
    eventId: string,
    consumerGroup = 'default',
    ttlMs = 86_400_000,
  ): Promise<void> {
    this.records.set(this.key(eventId, consumerGroup), Date.now() + ttlMs);
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * Wraps an EventHandler to ensure idempotent execution. Duplicate event deliveries
 * are detected and safely skipped without re-executing side effects.
 */
export function createIdempotentHandler(
  store: IdempotencyStore,
  consumerGroup: string,
  handler: (context: EventHandlerContext) => Promise<void>,
  options: {
    ttlMs?: number | undefined;
    onDuplicate?: ((context: EventHandlerContext) => void) | undefined;
  } = {},
): EventHandler {
  return async (context: EventHandlerContext) => {
    const alreadyProcessed = await store.hasProcessed(context.event.id, consumerGroup);
    if (alreadyProcessed) {
      options.onDuplicate?.(context);
      return;
    }
    await handler(context);
    await store.markProcessed(context.event.id, consumerGroup, options.ttlMs);
  };
}
