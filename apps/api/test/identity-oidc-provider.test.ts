import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OidcAuthenticationError,
  OidcIdentityProvider,
  loadOidcProviderConfiguration,
  type LoginTransaction,
  type LoginTransactionStore,
  type OidcProtocolClient,
} from '../src/identity/oidc-provider.js';

const configuration = {
  issuer: 'https://issuer.example.test/',
  clientId: 'api-client',
  clientSecret: 'server-secret',
  callbackUri: 'https://api.example.test/auth/callback',
  transactionTtlMs: 300_000,
};

class MemoryTransactions implements LoginTransactionStore {
  readonly values = new Map<string, LoginTransaction>();

  async create(transaction: LoginTransaction): Promise<void> {
    this.values.set(transaction.handle, transaction);
  }

  async consume(handle: string): Promise<LoginTransaction | null> {
    const transaction = this.values.get(handle);
    this.values.delete(handle);
    return transaction ?? null;
  }
}

class FakeOidcProtocol implements OidcProtocolClient {
  authorizationParameters: Parameters<OidcProtocolClient['buildAuthorizationUrl']>[0] | undefined;
  grantChecks: Parameters<OidcProtocolClient['authorizationCodeGrant']>[1] | undefined;
  claims: Record<string, unknown> = {
    iss: configuration.issuer,
    sub: 'provider-subject',
    aud: configuration.clientId,
    nonce: 'nonce-value',
    email: 'member@example.test',
    email_verified: true,
    name: 'Member Name',
  };
  grantError: unknown;

  randomState(): string { return 'state-value'; }
  randomNonce(): string { return 'nonce-value'; }
  randomPKCECodeVerifier(): string { return 'verifier-value'; }
  async calculatePKCECodeChallenge(verifier: string): Promise<string> { return `s256:${verifier}`; }
  buildAuthorizationUrl(parameters: Parameters<OidcProtocolClient['buildAuthorizationUrl']>[0]): URL {
    this.authorizationParameters = parameters;
    return new URL(`https://issuer.example.test/authorize?state=${parameters.state}`);
  }
  async authorizationCodeGrant(_callbackUrl: URL, checks: Parameters<OidcProtocolClient['authorizationCodeGrant']>[1]): Promise<Record<string, unknown>> {
    this.grantChecks = checks;
    if (this.grantError) throw this.grantError;
    return this.claims;
  }
}

function fixture(now = new Date('2026-11-14T10:00:00.000Z')) {
  const transactions = new MemoryTransactions();
  const protocol = new FakeOidcProtocol();
  const provider = new OidcIdentityProvider(configuration, transactions, protocol, () => now, () => 'opaque-transaction-handle');
  return { provider, transactions, protocol, now };
}

test('OIDC configuration remains absent when unconfigured and rejects partial or insecure config', () => {
  assert.equal(loadOidcProviderConfiguration({}), null);
  assert.throws(() => loadOidcProviderConfiguration({ OIDC_ISSUER: configuration.issuer }), /Incomplete/);
  assert.throws(() => loadOidcProviderConfiguration({
    OIDC_ISSUER: 'http://issuer.example.test/',
    OIDC_CLIENT_ID: configuration.clientId,
    OIDC_CLIENT_SECRET: configuration.clientSecret,
    OIDC_CALLBACK_URI: configuration.callbackUri,
  }), /Invalid OIDC/);
  assert.throws(() => loadOidcProviderConfiguration({
    OIDC_ISSUER: configuration.issuer,
    OIDC_CLIENT_ID: configuration.clientId,
    OIDC_CLIENT_SECRET: configuration.clientSecret,
    OIDC_CALLBACK_URI: 'https://api.example.test/auth/callback?next=https://evil.example',
  }), /Invalid OIDC/);
});

test('login creates independent state, nonce, verifier and fixed S256 authorization request', async () => {
  const { provider, transactions, protocol, now } = fixture();
  const login = await provider.beginLogin();
  const transaction = transactions.values.get(login.transactionHandle);

  assert.ok(transaction);
  assert.equal(transaction.state, 'state-value');
  assert.equal(transaction.nonce, 'nonce-value');
  assert.equal(transaction.codeVerifier, 'verifier-value');
  assert.equal(transaction.createdAt, now);
  assert.equal(transaction.expiresAt.getTime(), now.getTime() + configuration.transactionTtlMs);
  assert.deepEqual(protocol.authorizationParameters, {
    redirectUri: configuration.callbackUri,
    scope: 'openid email profile',
    state: 'state-value',
    nonce: 'nonce-value',
    codeChallenge: 's256:verifier-value',
  });
  assert.equal(login.authorizationUrl, 'https://issuer.example.test/authorize?state=state-value');
});

test('callback validates the code with its stored verifier/state/nonce and returns only verified identity claims', async () => {
  const { provider, protocol } = fixture();
  const login = await provider.beginLogin();
  const completed = await provider.completeLogin(
    new URL('https://api.example.test/auth/callback?code=opaque-code&state=state-value'),
    login.transactionHandle,
  );

  assert.deepEqual(protocol.grantChecks, {
    pkceCodeVerifier: 'verifier-value',
    expectedState: 'state-value',
    expectedNonce: 'nonce-value',
  });
  assert.deepEqual(completed, { identity: {
    issuer: configuration.issuer,
    subject: 'provider-subject',
    email: 'member@example.test',
    emailVerified: true,
    displayName: 'Member Name',
  } });
});

test('only one canonical invitation or bootstrap grant digest is retained in the transaction and returned after OIDC verification', async () => {
  const digest = Buffer.alloc(32, 4).toString('base64url');
  const { provider, transactions } = fixture();
  const inviteLogin = await provider.beginLogin({ invitationTokenHash: digest });
  assert.deepEqual(transactions.values.get(inviteLogin.transactionHandle)?.context, { invitationTokenHash: digest });
  const inviteCompleted = await provider.completeLogin(
    new URL('https://api.example.test/auth/callback?code=opaque-code&state=state-value'), inviteLogin.transactionHandle,
  );
  assert.equal(inviteCompleted.invitationTokenHash, digest);
  assert.equal(inviteCompleted.bootstrapGrantHash, undefined);

  const bootstrapLogin = await provider.beginLogin({ bootstrapGrantHash: digest });
  const bootstrapCompleted = await provider.completeLogin(
    new URL('https://api.example.test/auth/callback?code=opaque-code&state=state-value'), bootstrapLogin.transactionHandle,
  );
  assert.equal(bootstrapCompleted.bootstrapGrantHash, digest);
  assert.equal(bootstrapCompleted.invitationTokenHash, undefined);
});

test('OIDC transaction context rejects malformed, conflicting, and unexpected grant fields', async () => {
  const { provider, transactions } = fixture();
  const digest = Buffer.alloc(32, 4).toString('base64url');
  for (const context of [
    { invitationTokenHash: 'bad' },
    { invitationTokenHash: digest, bootstrapGrantHash: digest },
    { operatorSecret: 'must-not-persist' },
  ]) {
    await assert.rejects(provider.beginLogin(context as never), OidcAuthenticationError);
  }
  assert.equal(transactions.values.size, 0);
});

test('callback consumes the transaction once and rejects replay, wrong state, provider errors, and callback spoofing', async () => {
  const { provider, transactions } = fixture();
  const login = await provider.beginLogin();
  const callback = new URL('https://api.example.test/auth/callback?code=opaque-code&state=state-value');

  assert.equal(transactions.values.has(login.transactionHandle), true);
  await provider.completeLogin(callback, login.transactionHandle);
  await assert.rejects(provider.completeLogin(callback, login.transactionHandle), OidcAuthenticationError);

  const wrongStateLogin = await provider.beginLogin();
  await assert.rejects(
    provider.completeLogin(new URL('https://api.example.test/auth/callback?code=x&state=wrong'), wrongStateLogin.transactionHandle),
    OidcAuthenticationError,
  );
  const errorLogin = await provider.beginLogin();
  await assert.rejects(
    provider.completeLogin(new URL('https://api.example.test/auth/callback?error=access_denied&state=state-value'), errorLogin.transactionHandle),
    OidcAuthenticationError,
  );
  const spoofLogin = await provider.beginLogin();
  await assert.rejects(
    provider.completeLogin(new URL('https://attacker.example.test/auth/callback?code=x&state=state-value'), spoofLogin.transactionHandle),
    OidcAuthenticationError,
  );
});

test('callback rejects expired transactions and unverified or misbound provider claims', async () => {
  const expired = fixture(new Date('2026-11-14T10:05:00.000Z'));
  const expiredLogin = await expired.provider.beginLogin();
  const expiredRecord = expired.transactions.values.get(expiredLogin.transactionHandle);
  assert.ok(expiredRecord);
  expired.transactions.values.set(expiredLogin.transactionHandle, {
    ...expiredRecord,
    expiresAt: new Date('2026-11-14T10:04:59.999Z'),
  });
  await assert.rejects(
    expired.provider.completeLogin(new URL('https://api.example.test/auth/callback?code=x&state=state-value'), expiredLogin.transactionHandle),
    OidcAuthenticationError,
  );

  for (const mutate of [
    (claims: Record<string, unknown>) => { claims.email_verified = false; },
    (claims: Record<string, unknown>) => { claims.iss = 'https://attacker.example.test/'; },
    (claims: Record<string, unknown>) => { claims.aud = 'different-client'; },
    (claims: Record<string, unknown>) => { claims.azp = 'different-client'; },
    (claims: Record<string, unknown>) => { claims.nonce = 'wrong-nonce'; },
    (claims: Record<string, unknown>) => { claims.email = ''; },
  ]) {
    const { provider, protocol } = fixture();
    const login = await provider.beginLogin();
    mutate(protocol.claims);
    await assert.rejects(
      provider.completeLogin(new URL('https://api.example.test/auth/callback?code=x&state=state-value'), login.transactionHandle),
      OidcAuthenticationError,
    );
  }
});

test('provider errors are collapsed and never expose response details', async () => {
  const { provider, protocol } = fixture();
  const login = await provider.beginLogin();
  protocol.grantError = new Error('provider returned secret access_token=do-not-leak');
  await assert.rejects(
    provider.completeLogin(new URL('https://api.example.test/auth/callback?code=x&state=state-value'), login.transactionHandle),
    (error: unknown) => error instanceof OidcAuthenticationError && !error.message.includes('do-not-leak'),
  );
});
