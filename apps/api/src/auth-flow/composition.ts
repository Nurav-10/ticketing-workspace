import express, { type RequestHandler, type Router } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Config } from '../config/config.js';
import { UnconfiguredAuthenticator } from '../auth/authenticator.js';
import { SessionAuthenticator } from '../auth/session-authenticator.js';
import { PrismaIdentityRepository } from '../identity-persistence/prisma-identity-repository.js';
import { IdentityService } from '../identity-persistence/identity-service.js';
import { PrismaSessionRepository } from '../sessions/prisma-session-repository.js';
import { SessionService, type SessionPolicy } from '../sessions/session-service.js';
import { PrismaInvitationRepository } from '../invitations/prisma-invitation-repository.js';
import { PrismaBootstrapRepository } from '../bootstrap/prisma-bootstrap-repository.js';
import { BootstrapService } from '../bootstrap/bootstrap-service.js';
import { PrismaLoginTransactionStore, loadLoginTransactionEncryptionKey } from '../identity/prisma-login-transaction-store.js';
import { createOpenIdClient, loadOidcProviderConfiguration, OidcIdentityProvider } from '../identity/oidc-provider.js';
import { AuthFlowService } from './auth-flow-service.js';
import { OIDC_TRANSACTION_COOKIE_NAME, registerAuthRoutes } from './auth-routes.js';
import { registerBootstrapRoutes } from '../bootstrap/bootstrap-routes.js';

const TRANSACTION_KEY_ENV = 'OIDC_TRANSACTION_ENCRYPTION_KEY';

export interface AuthRateLimiters {
  /** Applied to both GET and POST `/login`. */
  login: RequestHandler;
  callback: RequestHandler;
  logout: RequestHandler;
  bootstrap?: RequestHandler;
}

export interface BootstrapCompositionOptions {
  expectedGrantHash: Buffer;
  workspace: { name: string; slug: string };
}

export interface AuthCompositionInput {
  config: Pick<Config, 'PUBLIC_ORIGIN' | 'SESSION_COOKIE_NAME'>;
  prisma: PrismaClient;
  sessionPolicy?: SessionPolicy;
  rateLimiters?: AuthRateLimiters;
  bootstrap?: BootstrapCompositionOptions;
  env?: NodeJS.ProcessEnv;
}

export interface UnconfiguredAuthComposition {
  configured: false;
  reason: 'provider_absent' | 'rate_limiters_missing';
  authenticator: UnconfiguredAuthenticator;
  router: null;
  mountPath: null;
}

export interface ConfiguredAuthComposition {
  configured: true;
  authenticator: SessionAuthenticator;
  router: Router;
  /** Mount this router at this path; callback URI must end in `/callback`. */
  mountPath: string;
  /** Kept for trusted server-side operations; never expose bootstrap start as a public route. */
  flow: AuthFlowService;
}

export type AuthComposition = UnconfiguredAuthComposition | ConfiguredAuthComposition;

export class AuthCompositionConfigurationError extends Error {
  constructor() {
    super('Authentication composition configuration is invalid');
    this.name = 'AuthCompositionConfigurationError';
  }
}

function failClosed(reason: UnconfiguredAuthComposition['reason']): UnconfiguredAuthComposition {
  return { configured: false, reason, authenticator: new UnconfiguredAuthenticator(), router: null, mountPath: null };
}

function hasRateLimiters(value: AuthRateLimiters | undefined): value is AuthRateLimiters {
  return !!value && typeof value.login === 'function' && typeof value.callback === 'function' && typeof value.logout === 'function';
}

function validatePublicOrigin(value: string): void {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new AuthCompositionConfigurationError(); }
  if (origin.protocol !== 'https:' || origin.origin !== value || origin.username || origin.password) {
    throw new AuthCompositionConfigurationError();
  }
}

function validateSessionCookieName(value: string): void {
  if (!/^__Host-[A-Za-z0-9_-]+$/.test(value) || value === OIDC_TRANSACTION_COOKIE_NAME) throw new AuthCompositionConfigurationError();
}

function deriveMountPath(callbackUri: string): string {
  const callback = new URL(callbackUri);
  // Keep the public auth endpoints away from health and protected API routes.
  if (callback.pathname !== '/api/v1/auth/callback') {
    throw new AuthCompositionConfigurationError();
  }
  return '/api/v1/auth';
}

function hasBootstrapOptions(value: unknown): value is BootstrapCompositionOptions {
  if (value === undefined) return false;
  if (!value || typeof value !== 'object') throw new AuthCompositionConfigurationError();
  const options = value as Partial<BootstrapCompositionOptions>;
  if (!Buffer.isBuffer(options.expectedGrantHash) || options.expectedGrantHash.byteLength !== 32
    || !options.workspace || typeof options.workspace.name !== 'string'
    || !options.workspace.name.trim() || options.workspace.name.length > 120
    || typeof options.workspace.slug !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.workspace.slug)
    || options.workspace.slug.length > 48) {
    throw new AuthCompositionConfigurationError();
  }
  return true;
}

/**
 * Creates a configured auth stack only when OIDC, dedicated encryption, session
 * policy, HTTPS origins, and all three injected rate limits are present. No
 * composition path resets or mutates the database schema.
 */
export async function composeAuthStack(input: AuthCompositionInput): Promise<AuthComposition> {
  const env = input.env ?? process.env;
  let providerConfiguration: ReturnType<typeof loadOidcProviderConfiguration>;
  try { providerConfiguration = loadOidcProviderConfiguration(env); }
  catch { throw new AuthCompositionConfigurationError(); }

  const bootstrapConfigured = hasBootstrapOptions(input.bootstrap);
  if (!providerConfiguration) {
    // Validate any supplied standalone transaction key rather than silently accepting a typo.
    if (env[TRANSACTION_KEY_ENV]) {
      try { loadLoginTransactionEncryptionKey(env); }
      catch { throw new AuthCompositionConfigurationError(); }
    }
    return failClosed('provider_absent');
  }

  let transactionEncryptionKey: Buffer;
  try { transactionEncryptionKey = loadLoginTransactionEncryptionKey(env); }
  catch { throw new AuthCompositionConfigurationError(); }
  if (bootstrapConfigured && input.bootstrap!.expectedGrantHash.equals(transactionEncryptionKey)) {
    throw new AuthCompositionConfigurationError();
  }

  validatePublicOrigin(input.config.PUBLIC_ORIGIN);
  validateSessionCookieName(input.config.SESSION_COOKIE_NAME);
  if (new URL(providerConfiguration.callbackUri).origin !== input.config.PUBLIC_ORIGIN) {
    throw new AuthCompositionConfigurationError();
  }
  const mountPath = deriveMountPath(providerConfiguration.callbackUri);
  if (!input.sessionPolicy) throw new AuthCompositionConfigurationError();
  if (!hasRateLimiters(input.rateLimiters)) return failClosed('rate_limiters_missing');
  if (bootstrapConfigured && typeof input.rateLimiters.bootstrap !== 'function') {
    return failClosed('rate_limiters_missing');
  }

  try {
    const protocol = await createOpenIdClient(providerConfiguration);
    const transactions = new PrismaLoginTransactionStore(input.prisma, transactionEncryptionKey);
    const provider = new OidcIdentityProvider(providerConfiguration, transactions, protocol);
    const identities = new IdentityService(new PrismaIdentityRepository(input.prisma));
    const sessions = new SessionService(new PrismaSessionRepository(input.prisma), input.sessionPolicy);
    const invitations = new PrismaInvitationRepository(input.prisma);
    const bootstrapper = bootstrapConfigured
      ? new BootstrapService(new PrismaBootstrapRepository(input.prisma), input.bootstrap!)
      : null;
    const flow = new AuthFlowService(provider, identities, sessions, input.config.PUBLIC_ORIGIN, invitations, bootstrapper);

    const router = express.Router();
    // Middleware is installed before route registration, so it wraps each handler.
    router.use('/login', input.rateLimiters.login);
    router.use('/callback', input.rateLimiters.callback);
    router.use('/logout', input.rateLimiters.logout);
    if (bootstrapConfigured) {
      const bootstrapRouter = express.Router();
      registerBootstrapRoutes(bootstrapRouter, flow, {
        publicOrigin: input.config.PUBLIC_ORIGIN,
        rateLimit: input.rateLimiters.bootstrap!,
        transactionCookieMaxAgeMs: providerConfiguration.transactionTtlMs,
      });
      router.use('/bootstrap', bootstrapRouter);
    }
    registerAuthRoutes(router, flow, {
      publicOrigin: input.config.PUBLIC_ORIGIN,
      callbackUri: providerConfiguration.callbackUri,
      sessionCookieName: input.config.SESSION_COOKIE_NAME,
      transactionCookieMaxAgeMs: providerConfiguration.transactionTtlMs,
    });

    // This configured value follows successful construction of actual OIDC verification,
    // identity/session persistence, trusted origin/cookie settings, and all rate-limit ports.
    const authenticator = new SessionAuthenticator(sessions, { providerAuthenticationComplete: true });
    return { configured: true, authenticator, router, mountPath, flow };
  } catch {
    // Discovery, key, repository, and crypto errors are not logged or echoed.
    throw new AuthCompositionConfigurationError();
  }
}
