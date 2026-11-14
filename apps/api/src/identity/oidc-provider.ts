import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';

export interface OidcProviderConfiguration {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  transactionTtlMs: number;
}

export interface LoginTransaction {
  handle: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  issuer: string;
  clientId: string;
  callbackUri: string;
  createdAt: Date;
  expiresAt: Date;
  /** Optional opaque grants; persisted only inside the encrypted transaction payload. */
  context?: LoginTransactionContext;
}

export interface LoginTransactionContext {
  invitationTokenHash?: string;
  bootstrapGrantHash?: string;
}

/**
 * Persistent implementations must create an expiring transaction and consume it
 * atomically (a single-use delete/claim). A consumed transaction is never restored,
 * including when callback validation fails.
 */
export interface LoginTransactionStore {
  create(transaction: LoginTransaction): Promise<void>;
  consume(handle: string, now: Date): Promise<LoginTransaction | null>;
}

export interface OidcGrantChecks {
  pkceCodeVerifier: string;
  expectedState: string;
  expectedNonce: string;
}

/** Narrow adapter around openid-client so the application boundary is deterministic in unit tests. */
export interface OidcProtocolClient {
  randomState(): string;
  randomNonce(): string;
  randomPKCECodeVerifier(): string;
  calculatePKCECodeChallenge(verifier: string): Promise<string>;
  buildAuthorizationUrl(parameters: {
    redirectUri: string;
    scope: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): URL;
  authorizationCodeGrant(callbackUrl: URL, checks: OidcGrantChecks): Promise<Record<string, unknown>>;
}

export interface VerifiedOidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: true;
  displayName?: string;
}

export interface CompletedOidcIdentity {
  identity: VerifiedOidcIdentity;
  invitationTokenHash?: string;
  bootstrapGrantHash?: string;
}

export interface StartedOidcLogin {
  /** Set only in a short-lived, HttpOnly transaction cookie by the future HTTP adapter. */
  transactionHandle: string;
  authorizationUrl: string;
}

export class OidcAuthenticationError extends Error {
  constructor() {
    super('OIDC authentication could not be completed');
    this.name = 'OidcAuthenticationError';
  }
}

function secureRandomHandle(): string {
  return randomBytes(32).toString('base64url');
}

function isCanonicalHttpsUrl(value: string, allowPath: boolean): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && (allowPath || parsed.pathname === '/')
      && parsed.href === value;
  } catch {
    return false;
  }
}

function assertConfiguration(configuration: OidcProviderConfiguration): void {
  if (!isCanonicalHttpsUrl(configuration.issuer, true)
    || !isCanonicalHttpsUrl(configuration.callbackUri, true)
    || configuration.clientId.trim() === ''
    || configuration.clientSecret.trim() === ''
    || !Number.isSafeInteger(configuration.transactionTtlMs)
    || configuration.transactionTtlMs < 1_000
    || configuration.transactionTtlMs > 15 * 60_000) {
    throw new Error('Invalid OIDC provider configuration');
  }
}

function isCanonicalDigest(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === value;
}

function validateContext(context: unknown): LoginTransactionContext | undefined {
  if (context === undefined) return undefined;
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new OidcAuthenticationError();
  const value = context as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'invitationTokenHash' && key !== 'bootstrapGrantHash')
    || (value.invitationTokenHash !== undefined && !isCanonicalDigest(value.invitationTokenHash))
    || (value.bootstrapGrantHash !== undefined && !isCanonicalDigest(value.bootstrapGrantHash))
    || (value.invitationTokenHash !== undefined && value.bootstrapGrantHash !== undefined)) {
    throw new OidcAuthenticationError();
  }
  if (value.invitationTokenHash === undefined && value.bootstrapGrantHash === undefined) return undefined;
  return {
    ...(value.invitationTokenHash === undefined ? {} : { invitationTokenHash: value.invitationTokenHash as string }),
    ...(value.bootstrapGrantHash === undefined ? {} : { bootstrapGrantHash: value.bootstrapGrantHash as string }),
  };
}

function constantTimeStringEqual(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertClaims(
  claims: Record<string, unknown>,
  configuration: OidcProviderConfiguration,
  transaction: LoginTransaction,
): VerifiedOidcIdentity {
  const issuer = claims.iss;
  const subject = claims.sub;
  const audience = claims.aud;
  const authorizedParty = claims.azp;
  const email = claims.email;
  const nonce = claims.nonce;
  const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
  if (issuer !== configuration.issuer
    || transaction.issuer !== configuration.issuer
    || transaction.clientId !== configuration.clientId
    || transaction.callbackUri !== configuration.callbackUri
    || typeof subject !== 'string' || subject.length === 0
    || !audiences.includes(configuration.clientId)
    || (audiences.length > 1 && authorizedParty !== configuration.clientId)
    || (authorizedParty !== undefined && authorizedParty !== configuration.clientId)
    || nonce !== transaction.nonce
    || typeof email !== 'string' || email.trim() === ''
    || claims.email_verified !== true) {
    throw new OidcAuthenticationError();
  }

  const identity: VerifiedOidcIdentity = {
    issuer: configuration.issuer,
    subject,
    email,
    emailVerified: true,
  };
  if (typeof claims.name === 'string' && claims.name.trim() !== '') identity.displayName = claims.name;
  return identity;
}

export class OidcIdentityProvider {
  constructor(
    private readonly configuration: OidcProviderConfiguration,
    private readonly transactions: LoginTransactionStore,
    private readonly protocol: OidcProtocolClient,
    private readonly now: () => Date = () => new Date(),
    private readonly createHandle: () => string = secureRandomHandle,
  ) {
    assertConfiguration(configuration);
  }

  /** Starts a fixed-scope authorization-code flow; callers cannot provide a redirect target. */
  async beginLogin(context?: LoginTransactionContext): Promise<StartedOidcLogin> {
    const safeContext = validateContext(context);
    const createdAt = this.now();
    const codeVerifier = this.protocol.randomPKCECodeVerifier();
    const state = this.protocol.randomState();
    const nonce = this.protocol.randomNonce();
    const codeChallenge = await this.protocol.calculatePKCECodeChallenge(codeVerifier);
    const handle = this.createHandle();
    const transaction: LoginTransaction = {
      handle,
      state,
      nonce,
      codeVerifier,
      issuer: this.configuration.issuer,
      clientId: this.configuration.clientId,
      callbackUri: this.configuration.callbackUri,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.configuration.transactionTtlMs),
      ...(safeContext ? { context: safeContext } : {}),
    };
    const url = this.protocol.buildAuthorizationUrl({
      redirectUri: this.configuration.callbackUri,
      scope: 'openid email profile',
      state,
      nonce,
      codeChallenge,
    });
    if (url.protocol !== 'https:') throw new OidcAuthenticationError();
    await this.transactions.create(transaction);
    return { transactionHandle: handle, authorizationUrl: url.href };
  }

  /** Consumes the transaction before validating callback data so every attempt is single-use. */
  async completeLogin(callbackUrl: URL, transactionHandle: string | undefined): Promise<CompletedOidcIdentity> {
    if (!transactionHandle || transactionHandle.length > 256) throw new OidcAuthenticationError();
    const transaction = await this.transactions.consume(transactionHandle, this.now());
    if (!transaction || transaction.handle !== transactionHandle || transaction.expiresAt.getTime() <= this.now().getTime()) {
      throw new OidcAuthenticationError();
    }

    const configuredCallback = new URL(this.configuration.callbackUri);
    if (callbackUrl.protocol !== 'https:'
      || callbackUrl.origin !== configuredCallback.origin
      || callbackUrl.pathname !== configuredCallback.pathname
      || callbackUrl.username !== ''
      || callbackUrl.password !== ''
      || callbackUrl.hash !== '') {
      throw new OidcAuthenticationError();
    }
    const callbackStates = callbackUrl.searchParams.getAll('state');
    if (callbackStates.length !== 1 || !constantTimeStringEqual(callbackStates[0] ?? null, transaction.state)
      || callbackUrl.searchParams.has('error')) {
      throw new OidcAuthenticationError();
    }

    try {
      const claims = await this.protocol.authorizationCodeGrant(callbackUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
      });
      const identity = assertClaims(claims, this.configuration, transaction);
      return {
        identity,
        ...(transaction.context?.invitationTokenHash ? { invitationTokenHash: transaction.context.invitationTokenHash } : {}),
        ...(transaction.context?.bootstrapGrantHash ? { bootstrapGrantHash: transaction.context.bootstrapGrantHash } : {}),
      };
    } catch {
      // Do not leak provider responses, codes, tokens, verifier material, or library errors.
      throw new OidcAuthenticationError();
    }
  }
}

/** Returns null when provider settings are wholly absent; partial/malformed setup fails closed. */
export function loadOidcProviderConfiguration(env: NodeJS.ProcessEnv = process.env): OidcProviderConfiguration | null {
  const names = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_CALLBACK_URI'] as const;
  const values = names.map((name) => env[name]);
  if (values.every((value) => value === undefined || value === '')) return null;
  if (values.some((value) => !value || value.trim() === '')) throw new Error('Incomplete OIDC provider configuration');
  const [issuer, clientId, clientSecret, callbackUri] = values as [string, string, string, string];
  const configuration: OidcProviderConfiguration = {
    issuer,
    clientId,
    clientSecret,
    callbackUri,
    transactionTtlMs: 5 * 60_000,
  };
  assertConfiguration(configuration);
  return configuration;
}

/** Performs discovery using the configured issuer and adapts the maintained protocol library. */
export async function createOpenIdClient(configuration: OidcProviderConfiguration): Promise<OidcProtocolClient> {
  assertConfiguration(configuration);
  const client = await oidc.discovery(
    new URL(configuration.issuer),
    configuration.clientId,
    configuration.clientSecret,
  );
  return {
    randomState: oidc.randomState,
    randomNonce: oidc.randomNonce,
    randomPKCECodeVerifier: oidc.randomPKCECodeVerifier,
    calculatePKCECodeChallenge: oidc.calculatePKCECodeChallenge,
    buildAuthorizationUrl(parameters) {
      return oidc.buildAuthorizationUrl(client, {
        redirect_uri: parameters.redirectUri,
        scope: parameters.scope,
        response_type: 'code',
        state: parameters.state,
        nonce: parameters.nonce,
        code_challenge: parameters.codeChallenge,
        code_challenge_method: 'S256',
      });
    },
    async authorizationCodeGrant(callbackUrl, checks) {
      const tokens = await oidc.authorizationCodeGrant(client, callbackUrl, {
        pkceCodeVerifier: checks.pkceCodeVerifier,
        expectedState: checks.expectedState,
        expectedNonce: checks.expectedNonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new OidcAuthenticationError();
      return claims as Record<string, unknown>;
    },
  };
}
