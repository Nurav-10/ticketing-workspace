import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { LoginTransactionStoreError, PrismaLoginTransactionStore } from '../src/identity/prisma-login-transaction-store.js';
import type { LoginTransaction } from '../src/identity/oidc-provider.js';
import { pool, prisma } from './test-database.js';

function transaction(handle: string, now = new Date()): LoginTransaction {
  return {
    handle,
    state: `state-${randomBytes(24).toString('hex')}`,
    nonce: `nonce-${randomBytes(24).toString('hex')}`,
    codeVerifier: `verifier-${randomBytes(32).toString('base64url')}`,
    issuer: 'https://issuer.example.test/',
    clientId: 'integration-client-id',
    callbackUri: 'https://api.example.test/auth/callback',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 5 * 60_000),
  };
}

function newHandle(): string {
  return randomBytes(32).toString('base64url');
}

test('login transactions persist only a handle digest and authenticated ciphertext, then consume once', async () => {
  const handle = newHandle();
  const invitationTokenHash = randomBytes(32).toString('base64url');
  const record: LoginTransaction = { ...transaction(handle), context: { invitationTokenHash } };
  const key = randomBytes(32);
  const store = new PrismaLoginTransactionStore(prisma, key);
  const handleHash = createHash('sha256').update(Buffer.from(handle, 'base64url')).digest();
  try {
    await store.create(record);
    const stored = await pool.query<{
      handle_hash: Buffer;
      encrypted_payload: Buffer;
      encryption_iv: Buffer;
      authentication_tag: Buffer;
    }>(`SELECT handle_hash, encrypted_payload, encryption_iv, authentication_tag
         FROM login_transactions WHERE handle_hash = $1`, [handleHash]);
    assert.equal(stored.rows.length, 1);
    assert.deepEqual(stored.rows[0]?.handle_hash, handleHash);
    assert.equal(stored.rows[0]?.encryption_iv.length, 12);
    assert.equal(stored.rows[0]?.authentication_tag.length, 16);
    const ciphertext = stored.rows[0]?.encrypted_payload;
    assert.ok(ciphertext);
    for (const plaintext of [handle, record.state, record.nonce, record.codeVerifier, record.issuer, record.clientId, record.callbackUri, invitationTokenHash]) {
      assert.equal(ciphertext.includes(Buffer.from(plaintext, 'utf8')), false);
    }

    const consumed = await store.consume(handle, new Date(0));
    assert.ok(consumed);
    assert.equal(consumed.handle, handle);
    assert.equal(consumed.state, record.state);
    assert.equal(consumed.nonce, record.nonce);
    assert.equal(consumed.codeVerifier, record.codeVerifier);
    assert.equal(consumed.issuer, record.issuer);
    assert.equal(consumed.clientId, record.clientId);
    assert.equal(consumed.callbackUri, record.callbackUri);
    assert.deepEqual(consumed.context, { invitationTokenHash });
    assert.equal(await store.consume(handle, new Date()), null);
  } finally {
    await pool.query('DELETE FROM login_transactions WHERE handle_hash = $1', [handleHash]);
  }
});

test('concurrent login transaction consumption has exactly one winner', async () => {
  const handle = newHandle();
  const key = randomBytes(32);
  const storeA = new PrismaLoginTransactionStore(prisma, key);
  const storeB = new PrismaLoginTransactionStore(prisma, key);
  const handleHash = createHash('sha256').update(Buffer.from(handle, 'base64url')).digest();
  try {
    await storeA.create(transaction(handle));
    const results = await Promise.all([
      storeA.consume(handle, new Date()),
      storeB.consume(handle, new Date()),
    ]);
    assert.equal(results.filter((result) => result !== null).length, 1);
    assert.equal(results.filter((result) => result === null).length, 1);
  } finally {
    await pool.query('DELETE FROM login_transactions WHERE handle_hash = $1', [handleHash]);
  }
});

test('expired transactions are consumed and rejected using PostgreSQL time', async () => {
  const handle = newHandle();
  const key = randomBytes(32);
  const store = new PrismaLoginTransactionStore(prisma, key);
  const handleHash = createHash('sha256').update(Buffer.from(handle, 'base64url')).digest();
  try {
    const record = transaction(handle);
    record.expiresAt = new Date(record.createdAt.getTime() + 1);
    await store.create(record);
    await pool.query('SELECT pg_sleep(0.05)');
    assert.equal(await store.consume(handle, new Date(0)), null);
    const remaining = await pool.query('SELECT count(*)::int AS count FROM login_transactions WHERE handle_hash = $1', [handleHash]);
    assert.equal(remaining.rows[0]?.count, 0);
  } finally {
    await pool.query('DELETE FROM login_transactions WHERE handle_hash = $1', [handleHash]);
  }
});

test('authenticated encryption failures are generic and still consume the transaction', async () => {
  const handle = newHandle();
  const handleHash = createHash('sha256').update(Buffer.from(handle, 'base64url')).digest();
  const writer = new PrismaLoginTransactionStore(prisma, randomBytes(32));
  const reader = new PrismaLoginTransactionStore(prisma, randomBytes(32));
  try {
    await writer.create(transaction(handle));
    await assert.rejects(
      reader.consume(handle, new Date()),
      (error: unknown) => error instanceof LoginTransactionStoreError && error.message === 'Login transaction storage failed',
    );
    const remaining = await pool.query('SELECT count(*)::int AS count FROM login_transactions WHERE handle_hash = $1', [handleHash]);
    assert.equal(remaining.rows[0]?.count, 0);
  } finally {
    await pool.query('DELETE FROM login_transactions WHERE handle_hash = $1', [handleHash]);
  }
});

test('migration constraints reject malformed handle hashes and invalid encryption metadata', async () => {
  const validHandleHash = randomBytes(32);
  await pool.query(
    `INSERT INTO login_transactions(handle_hash, encrypted_payload, encryption_iv, authentication_tag, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 minute')`,
    [randomBytes(31), Buffer.from([1]), randomBytes(12), randomBytes(16)],
  ).then(
    () => assert.fail('short handle digest unexpectedly succeeded'),
    (error: { code?: string }) => assert.equal(error.code, '23514'),
  );
  await pool.query(
    `INSERT INTO login_transactions(handle_hash, encrypted_payload, encryption_iv, authentication_tag, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 minute')`,
    [validHandleHash, Buffer.from([1]), randomBytes(11), randomBytes(16)],
  ).then(
    () => assert.fail('invalid encryption IV unexpectedly succeeded'),
    (error: { code?: string }) => assert.equal(error.code, '23514'),
  );
});
