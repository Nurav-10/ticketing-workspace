import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from './test-database.js';
import { PgOutboxRepository } from '../src/outbox/pg-outbox-repository.js';
import { OutboxWorker } from '../src/outbox/outbox-worker.js';
import { BackoffPolicy } from '../src/outbox/backoff.js';
import { InMemoryIdempotencyStore, createIdempotentHandler } from '../src/outbox/idempotency.js';

async function createTestFixtures() {
  const workspaceId = randomUUID();
  const teamId = randomUUID();
  const userId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`,
      [workspaceId, 'Outbox Test Workspace', `outbox-${workspaceId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`,
      [userId, `outbox-${userId.slice(0, 8)}@example.com`, 'Outbox User'],
    );
    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [workspaceId, userId],
    );
    await client.query(
      `INSERT INTO teams (id, workspace_id, name, key) VALUES ($1, $2, $3, $4)`,
      [teamId, workspaceId, 'Outbox Team', `T${teamId.slice(0, 4).toUpperCase()}`],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { workspaceId, teamId, userId };
}

async function createTestIssue(workspaceId: string, teamId: string, userId: string): Promise<string> {
  const issueId = randomUUID();
  await pool.query(
    `
    INSERT INTO issues (id, workspace_id, team_id, issue_number, title, created_by_user_id)
    VALUES ($1, $2, $3, 1, 'Outbox Test Issue', $4)
    `,
    [issueId, workspaceId, teamId, userId],
  );
  return issueId;
}

test('Durable outbox additive migration: schema, constraints and indexes exist', async () => {
  // Check new columns on outbox_events
  const columns = await pool.query<{ column_name: string; data_type: string }>(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'outbox_events'
      AND column_name IN ('claimed_by', 'lease_expires_at', 'dead_lettered_at', 'dead_letter_reason', 'last_error', 'workspace_sequence')
  `);
  const colMap = new Map(columns.rows.map((r) => [r.column_name, r.data_type]));
  assert.equal(colMap.get('claimed_by'), 'character varying');
  assert.equal(colMap.get('lease_expires_at'), 'timestamp with time zone');
  assert.equal(colMap.get('dead_lettered_at'), 'timestamp with time zone');
  assert.equal(colMap.get('dead_letter_reason'), 'text');
  assert.equal(colMap.get('last_error'), 'text');
  assert.equal(colMap.get('workspace_sequence'), 'bigint');

  // Check workspace_outbox_sequences table
  const tableCheck = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables WHERE table_name = 'workspace_outbox_sequences'
  `);
  assert.equal(tableCheck.rows.length, 1);

  // Check indexes
  const indexes = await pool.query<{ indexname: string }>(`
    SELECT indexname FROM pg_indexes WHERE tablename = 'outbox_events'
  `);
  const indexNames = new Set(indexes.rows.map((r) => r.indexname));
  assert.ok(indexNames.has('outbox_events_claim_idx'), 'outbox_events_claim_idx index exists');
  assert.ok(indexNames.has('outbox_events_lease_idx'), 'outbox_events_lease_idx index exists');
  assert.ok(indexNames.has('outbox_events_dead_letter_idx'), 'outbox_events_dead_letter_idx index exists');
  assert.ok(indexNames.has('outbox_events_workspace_seq_idx'), 'outbox_events_workspace_seq_idx index exists');
});

test('Bounded lease claims: claims up to batch limit with bounded lease', async () => {
  const { workspaceId, teamId, userId } = await createTestFixtures();
  const issueId = await createTestIssue(workspaceId, teamId, userId);
  const repo = new PgOutboxRepository(pool);

  // Insert 5 events
  for (let i = 0; i < 5; i++) {
    await repo.insertEvent({
      workspaceId,
      teamId,
      issueId,
      eventKind: 'issue.updated',
      payload: { issue_id: issueId, version: i + 1 },
    });
  }

  // Claim batch with batchSize = 3, lease duration = 15s
  const batch = await repo.claimBatch({
    workerId: 'test-worker-1',
    batchSize: 3,
    leaseDurationMs: 15_000,
    workspaceId,
  });

  assert.equal(batch.length, 3, 'Claimed exactly batch limit of 3');
  for (const event of batch) {
    assert.equal(event.claimedBy, 'test-worker-1');
    assert.ok(event.leaseExpiresAt !== null, 'Lease expiration is set');
    assert.ok(event.leaseExpiresAt.getTime() > Date.now(), 'Lease expiration is in future');
  }

  // Immediate second claim with batchSize = 3 returns remaining 2
  const secondBatch = await repo.claimBatch({
    workerId: 'test-worker-2',
    batchSize: 3,
    leaseDurationMs: 15_000,
    workspaceId,
  });
  assert.equal(secondBatch.length, 2, 'Claimed remaining 2 events');

  // Third claim returns 0 (all 5 currently leased)
  const thirdBatch = await repo.claimBatch({
    workerId: 'test-worker-3',
    batchSize: 3,
    leaseDurationMs: 15_000,
    workspaceId,
  });
  assert.equal(thirdBatch.length, 0, 'No more ready unleased events');
});

test('Multi-connection concurrency: concurrent workers claim disjoint sets with SKIP LOCKED', async () => {
  const { workspaceId, teamId, userId } = await createTestFixtures();
  const issueId = await createTestIssue(workspaceId, teamId, userId);
  const repo = new PgOutboxRepository(pool);

  const totalEvents = 18;
  for (let i = 0; i < totalEvents; i++) {
    await repo.insertEvent({
      workspaceId,
      teamId,
      issueId,
      eventKind: 'issue.updated',
      payload: { issue_id: issueId, version: i + 1 },
    });
  }

  // 3 concurrent workers claiming batches of 6 simultaneously
  const [batch1, batch2, batch3] = await Promise.all([
    repo.claimBatch({ workerId: 'worker-A', batchSize: 6, leaseDurationMs: 30_000, workspaceId }),
    repo.claimBatch({ workerId: 'worker-B', batchSize: 6, leaseDurationMs: 30_000, workspaceId }),
    repo.claimBatch({ workerId: 'worker-C', batchSize: 6, leaseDurationMs: 30_000, workspaceId }),
  ]);

  assert.equal(batch1.length, 6);
  assert.equal(batch2.length, 6);
  assert.equal(batch3.length, 6);

  const allClaimedIds = [...batch1, ...batch2, ...batch3].map((e) => e.id);
  const uniqueClaimedIds = new Set(allClaimedIds);

  assert.equal(uniqueClaimedIds.size, totalEvents, 'All claimed events are mutually exclusive (zero duplicates)');
});

test('Crash recovery: expired leases from crashed workers are reclaimed automatically', async () => {
  const { workspaceId, teamId, userId } = await createTestFixtures();
  const issueId = await createTestIssue(workspaceId, teamId, userId);
  const repo = new PgOutboxRepository(pool);

  const event = await repo.insertEvent({
    workspaceId,
    teamId,
    issueId,
    eventKind: 'issue.updated',
    payload: { issue_id: issueId, version: 1 },
  });

  // Worker 1 claims with a short lease (800 ms) and "crashes"
  const claimed = await repo.claimBatch({
    workerId: 'crashed-worker',
    batchSize: 1,
    leaseDurationMs: 800,
    workspaceId,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.id, event.id);

  // Immediately, another worker cannot claim it
  const immediate = await repo.claimBatch({
    workerId: 'active-worker',
    batchSize: 1,
    leaseDurationMs: 5_000,
    workspaceId,
  });
  assert.equal(immediate.length, 0, 'Cannot claim while lease is active');

  // Wait for the lease to expire
  await new Promise((r) => setTimeout(r, 900));

  // Worker 2 reclaims the expired lease automatically
  const recovered = await repo.claimBatch({
    workerId: 'active-worker',
    batchSize: 1,
    leaseDurationMs: 5_000,
    workspaceId,
  });
  assert.equal(recovered.length, 1, 'Successfully reclaimed expired lease');
  assert.equal(recovered[0]?.id, event.id);
  assert.equal(recovered[0]?.claimedBy, 'active-worker');

  // Complete delivery
  await repo.markDelivered(event.id);
  const afterDelivery = await repo.claimBatch({
    workerId: 'active-worker',
    batchSize: 1,
    leaseDurationMs: 5_000,
    workspaceId,
  });
  assert.equal(afterDelivery.length, 0, 'Delivered event is never reclaimed');
});

test('Retry backoff and dead-letter transitions in PostgreSQL', async () => {
  const { workspaceId, teamId, userId } = await createTestFixtures();
  const issueId = await createTestIssue(workspaceId, teamId, userId);
  const repo = new PgOutboxRepository(pool);

  const event = await repo.insertEvent({
    workspaceId,
    teamId,
    issueId,
    eventKind: 'issue.updated',
    payload: { issue_id: issueId, version: 1 },
  });

  // Record a transient failure with a future nextAttemptAt
  const futureAttempt = new Date(Date.now() + 60_000);
  await repo.recordFailure({
    eventId: event.id,
    error: 'Temporary connection reset',
    nextAttemptAt: futureAttempt,
    deadLetter: false,
  });

  // Verify it is not claimable now
  const pendingClaims = await repo.claimBatch({
    workerId: 'worker',
    batchSize: 1,
    leaseDurationMs: 5_000,
    workspaceId,
  });
  assert.equal(pendingClaims.length, 0, 'Event with future next_attempt_at is not claimed');

  // Now record max retries reached -> dead letter
  await repo.recordFailure({
    eventId: event.id,
    error: 'Fatal payload schema corruption',
    deadLetter: true,
    deadLetterReason: 'Max retries exceeded: Fatal payload schema corruption',
  });

  // Verify dead letter state in DB
  const rawRow = await pool.query<{
    dead_lettered_at: Date | null;
    dead_letter_reason: string | null;
    last_error: string | null;
    retry_count: number;
  }>('SELECT dead_lettered_at, dead_letter_reason, last_error, retry_count FROM outbox_events WHERE id = $1', [event.id]);

  assert.ok(rawRow.rows[0]?.dead_lettered_at !== null, 'dead_lettered_at is set');
  assert.equal(rawRow.rows[0]?.retry_count, 2);
  assert.equal(rawRow.rows[0]?.last_error, 'Fatal payload schema corruption');
  assert.ok(rawRow.rows[0]?.dead_letter_reason?.includes('Max retries exceeded'));

  // Health metrics reflect dead letter
  const health = await repo.getQueueHealth(workspaceId);
  assert.equal(health.deadLetterCount, 1);
  assert.equal(health.pendingCount, 0);
});

test('Monotonic per-workspace sequence allocation under concurrent transactions', async () => {
  const { workspaceId, teamId, userId } = await createTestFixtures();
  const issueId = await createTestIssue(workspaceId, teamId, userId);
  const repo = new PgOutboxRepository(pool);

  // Concurrently insert 10 events in the same workspace across 10 parallel connections
  const parallelInserts = Array.from({ length: 10 }, (_, i) =>
    repo.insertEvent({
      workspaceId,
      teamId,
      issueId,
      eventKind: 'issue.updated',
      payload: { issue_id: issueId, version: i + 1 },
    }),
  );

  const insertedEvents = await Promise.all(parallelInserts);
  const sequences = insertedEvents.map((e) => Number(e.workspaceSequence)).sort((a, b) => a - b);

  // Sequences must be strictly 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 without gaps or duplicates
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // Separate workspace starts sequence at 1 independently
  const otherWs = await createTestFixtures();
  const otherIssue = await createTestIssue(otherWs.workspaceId, otherWs.teamId, otherWs.userId);
  const otherEvent = await repo.insertEvent({
    workspaceId: otherWs.workspaceId,
    teamId: otherWs.teamId,
    issueId: otherIssue,
    eventKind: 'issue.updated',
    payload: { issue_id: otherIssue, version: 1 },
  });
  assert.equal(Number(otherEvent.workspaceSequence), 1);
});

test('End-to-end OutboxWorker with at-least-once delivery and consumer idempotency', async () => {
  const { workspaceId, teamId, userId } = await createTestFixtures();
  const issueId = await createTestIssue(workspaceId, teamId, userId);
  const repo = new PgOutboxRepository(pool);
  const idempotencyStore = new InMemoryIdempotencyStore();

  const event1 = await repo.insertEvent({
    workspaceId,
    teamId,
    issueId,
    eventKind: 'issue.created',
    payload: { issue_id: issueId, version: 1 },
  });
  const event2 = await repo.insertEvent({
    workspaceId,
    teamId,
    issueId,
    eventKind: 'issue.created',
    payload: { issue_id: issueId, version: 2 },
  });

  const processedEvents: string[] = [];
  const rawConsumer = async ({ event }: { event: typeof event1 }) => {
    processedEvents.push(event.id);
  };

  const idempotentConsumer = createIdempotentHandler(idempotencyStore, 'linear-sync-group', rawConsumer);

  const worker = new OutboxWorker(repo, {
    batchSize: 10,
    pollIntervalMs: 100,
    leaseDurationMs: 10_000,
    workspaceId,
    backoffPolicy: new BackoffPolicy({ maxRetries: 3 }),
  });
  worker.registerHandler('issue.created', idempotentConsumer);

  // Process batch
  const processedCount = await worker.processBatch();
  assert.equal(processedCount, 2);
  assert.deepEqual(processedEvents.sort(), [event1.id, event2.id].sort());

  // Verify health metrics
  const health = await repo.getQueueHealth(workspaceId);
  assert.equal(health.deliveredCount, 2);
  assert.equal(health.pendingCount, 0);

  // Simulate redelivery (at-least-once contract where worker crashed before clearing lease)
  await pool.query('UPDATE outbox_events SET delivered_at = NULL, lease_expires_at = NULL WHERE id = $1', [event1.id]);

  // Re-process
  await worker.processBatch();

  // The consumer's idempotency store deduplicated event1: processedEvents count did NOT increase
  assert.equal(processedEvents.length, 2, 'Consumer idempotency safely prevented duplicate processing');
});
