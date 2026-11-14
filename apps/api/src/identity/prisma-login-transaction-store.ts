import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { LoginTransaction, LoginTransactionStore } from './oidc-provider.js';

const KEY_ENVIRONMENT_VARIABLE = 'OIDC_TRANSACTION_ENCRYPTION_KEY';
const MAX_TRANSACTION_TTL_MS = 15 * 60_000;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENCRYPTION_VERSION = 'oidc-login-transaction:v1';

export class LoginTransactionStoreError extends Error {
  constructor() {
    super('Login transaction storage failed');
    this.name = 'LoginTransactionStoreError';
  }
}

interface DatabaseTransactionTimes {
  created_at_text: string;
  expires_at_text: string;
}

interface ConsumedDatabaseTransaction extends DatabaseTransactionTimes {
  encrypted_payload: Buffer;
  encryption_iv: Buffer;
  authentication_tag: Buffer;
  is_live: boolean;
}

function parseEncryptionKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`${KEY_ENVIRONMENT_VARIABLE} must be a base64url-encoded 32-byte key`);
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw new Error(`${KEY_ENVIRONMENT_VARIABLE} must be a base64url-encoded 32-byte key`);
  }
  return key;
}

export function loadLoginTransactionEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseEncryptionKey(env[KEY_ENVIRONMENT_VARIABLE]);
}

function hashHandle(handle: string): Buffer | null {
  if (!HANDLE_PATTERN.test(handle)) return null;
  const decoded = Buffer.from(handle, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== handle) return null;
  return createHash('sha256').update(decoded).digest();
}

function associatedData(handleHash: Buffer, createdAt: string, expiresAt: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${ENCRYPTION_VERSION}\0`, 'utf8'),
    handleHash,
    Buffer.from(`\0${createdAt}\0${expiresAt}`, 'utf8'),
  ]);
}

function isCanonicalDigest(digest: unknown): digest is string {
  if (typeof digest !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(digest)) return false;
  const bytes = Buffer.from(digest, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === digest;
}

function isValidContext(context: unknown): boolean {
  if (context === undefined) return true;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
  const candidate = context as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return !keys.some((key) => key !== 'invitationTokenHash' && key !== 'bootstrapGrantHash')
    && (candidate.invitationTokenHash === undefined || isCanonicalDigest(candidate.invitationTokenHash))
    && (candidate.bootstrapGrantHash === undefined || isCanonicalDigest(candidate.bootstrapGrantHash))
    && !(candidate.invitationTokenHash !== undefined && candidate.bootstrapGrantHash !== undefined);
}

function encryptTransaction(
  transaction: LoginTransaction,
  handleHash: Buffer,
  createdAt: string,
  expiresAt: string,
  key: Buffer,
): { ciphertext: Buffer; iv: Buffer; authenticationTag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(handleHash, createdAt, expiresAt));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(transaction), 'utf8'),
    cipher.final(),
  ]);
  return { ciphertext, iv, authenticationTag: cipher.getAuthTag() };
}

function decryptTransaction(
  row: ConsumedDatabaseTransaction,
  handleHash: Buffer,
  handle: string,
  key: Buffer,
): LoginTransaction {
  const decipher = createDecipheriv('aes-256-gcm', key, row.encryption_iv);
  decipher.setAAD(associatedData(handleHash, row.created_at_text, row.expires_at_text));
  decipher.setAuthTag(row.authentication_tag);
  const plaintext = Buffer.concat([
    decipher.update(row.encrypted_payload),
    decipher.final(),
  ]).toString('utf8');
  const parsed: unknown = JSON.parse(plaintext);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LoginTransactionStoreError();
  const value = parsed as Record<string, unknown>;
  const stringFields = ['state', 'nonce', 'codeVerifier', 'issuer', 'clientId', 'callbackUri'];
  if (value.handle !== handle || stringFields.some((field) => typeof value[field] !== 'string')) {
    throw new LoginTransactionStoreError();
  }
  let context: LoginTransaction['context'];
  if (value.context !== undefined) {
    if (!value.context || typeof value.context !== 'object' || Array.isArray(value.context)) throw new LoginTransactionStoreError();
    const candidate = value.context as Record<string, unknown>;
    const keys = Object.keys(candidate);
    if (keys.some((key) => key !== 'invitationTokenHash' && key !== 'bootstrapGrantHash')
      || (candidate.invitationTokenHash !== undefined && !isCanonicalDigest(candidate.invitationTokenHash))
      || (candidate.bootstrapGrantHash !== undefined && !isCanonicalDigest(candidate.bootstrapGrantHash))
      || (candidate.invitationTokenHash !== undefined && candidate.bootstrapGrantHash !== undefined)) {
      throw new LoginTransactionStoreError();
    }
    if (candidate.invitationTokenHash !== undefined || candidate.bootstrapGrantHash !== undefined) {
      context = {
        ...(candidate.invitationTokenHash === undefined ? {} : { invitationTokenHash: candidate.invitationTokenHash as string }),
        ...(candidate.bootstrapGrantHash === undefined ? {} : { bootstrapGrantHash: candidate.bootstrapGrantHash as string }),
      };
    }
  }
  return {
    handle,
    state: value.state as string,
    nonce: value.nonce as string,
    codeVerifier: value.codeVerifier as string,
    issuer: value.issuer as string,
    clientId: value.clientId as string,
    callbackUri: value.callbackUri as string,
    createdAt: new Date(row.created_at_text),
    expiresAt: new Date(row.expires_at_text),
    ...(context ? { context } : {}),
  };
}

/**
 * IMPORTANT: encryptionKey must be a dedicated 32-byte secret, supplied explicitly
 * from a secret manager. Do not derive it from DATABASE_URL, clientSecret, or any other
 * application key. This store never writes plaintext transaction values to PostgreSQL.
 */
export class PrismaLoginTransactionStore implements LoginTransactionStore {
  private readonly encryptionKey: Buffer;

  constructor(private readonly prisma: PrismaClient, encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) throw new Error('OIDC transaction encryption key must be exactly 32 bytes');
    this.encryptionKey = Buffer.from(encryptionKey);
  }

  async create(transaction: LoginTransaction): Promise<void> {
    const handleHash = hashHandle(transaction.handle);
    const ttlMs = transaction.expiresAt.getTime() - transaction.createdAt.getTime();
    if (!handleHash || !isValidContext(transaction.context)
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TRANSACTION_TTL_MS) {
      throw new LoginTransactionStoreError();
    }

    try {
      await this.prisma.$transaction(async (database) => {
        const rows = await database.$queryRaw<DatabaseTransactionTimes[]>`
          INSERT INTO login_transactions (
            handle_hash, encrypted_payload, encryption_iv, authentication_tag, expires_at
          ) VALUES (
            ${handleHash}, ${Buffer.from([0])}, ${Buffer.alloc(12)}, ${Buffer.alloc(16)},
            now() + (${ttlMs} * interval '1 millisecond')
          )
          RETURNING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
                    to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at_text`;
        const times = rows[0];
        if (!times) throw new LoginTransactionStoreError();

        const transactionToEncrypt: LoginTransaction = {
          ...transaction,
          createdAt: new Date(times.created_at_text),
          expiresAt: new Date(times.expires_at_text),
        };
        const encrypted = encryptTransaction(
          transactionToEncrypt,
          handleHash,
          times.created_at_text,
          times.expires_at_text,
          this.encryptionKey,
        );
        const updated = await database.$executeRaw`
          UPDATE login_transactions
             SET encrypted_payload = ${encrypted.ciphertext},
                 encryption_iv = ${encrypted.iv},
                 authentication_tag = ${encrypted.authenticationTag}
           WHERE handle_hash = ${handleHash}`;
        if (updated !== 1) throw new LoginTransactionStoreError();
      });
    } catch {
      throw new LoginTransactionStoreError();
    }
  }

  async consume(handle: string, _applicationNow: Date): Promise<LoginTransaction | null> {
    const handleHash = hashHandle(handle);
    if (!handleHash) return null;

    try {
      const rows = await this.prisma.$queryRaw<ConsumedDatabaseTransaction[]>`
        DELETE FROM login_transactions
         WHERE handle_hash = ${handleHash}
        RETURNING encrypted_payload, encryption_iv, authentication_tag,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
                  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at_text,
                  expires_at > clock_timestamp() AS is_live`;
      const row = rows[0];
      if (!row || !row.is_live) return null;
      return decryptTransaction(row, handleHash, handle, this.encryptionKey);
    } catch {
      // The row was consumed even when authenticated decryption fails. Never leak DB or crypto details.
      throw new LoginTransactionStoreError();
    }
  }
}
