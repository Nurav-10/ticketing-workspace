import type { Request, RequestHandler } from 'express';
import type { ClientAddressPolicy } from './client-address.js';
import { resolveClientAddress } from './client-address.js';
import type { RateLimitDecision } from './rate-limiter.js';
import { RateLimiter } from './rate-limiter.js';

type IdentifierResolver = (request: Request) => string | null;

export interface RateLimitDimension {
  operation: string;
  identifier: IdentifierResolver;
}

export interface RateLimitMiddlewareOptions {
  dimensions: readonly RateLimitDimension[];
}

export interface AuthLimiterHandlers {
  login: RequestHandler;
  callback: RequestHandler;
  logout: RequestHandler;
  bootstrap: RequestHandler;
}

export interface InvitationLimiterHandlers {
  issue: RequestHandler;
  redeem: RequestHandler;
}

const TOO_MANY_REQUESTS = {
  error: { code: 'rate_limited', message: 'Too many requests' },
};

/** Build a fail-closed Express middleware that charges all configured buckets. */
export function createRateLimitMiddleware(
  limiter: Pick<RateLimiter, 'consume'>,
  options: RateLimitMiddlewareOptions,
): RequestHandler {
  if (!Array.isArray(options?.dimensions) || options.dimensions.length === 0
    || options.dimensions.some((dimension) => !dimension || typeof dimension.operation !== 'string'
      || typeof dimension.identifier !== 'function')) {
    throw new Error('At least one valid rate-limit dimension must be configured');
  }

  return async (request, response, next) => {
    let retryAfterMs = 1_000;
    for (const dimension of options.dimensions) {
      let identifier: string | null;
      try { identifier = dimension.identifier(request); }
      catch { identifier = null; }
      if (typeof identifier !== 'string' || identifier.trim().length === 0) {
        response.setHeader('Retry-After', '1');
        response.status(429).json(TOO_MANY_REQUESTS);
        return;
      }

      let decision: RateLimitDecision;
      try { decision = await limiter.consume(dimension.operation, identifier); }
      catch {
        response.setHeader('Retry-After', '1');
        response.status(429).json(TOO_MANY_REQUESTS);
        return;
      }
      if (!decision.allowed) {
        retryAfterMs = Math.max(1_000, decision.retryAfterMs);
        response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
        response.status(429).json(TOO_MANY_REQUESTS);
        return;
      }
    }
    next();
  };
}

function clientIp(policy: ClientAddressPolicy): IdentifierResolver {
  return (request) => resolveClientAddress({
    socketRemoteAddress: request.socket.remoteAddress,
    forwardedFor: request.get('x-forwarded-for'),
    policy,
  });
}

/** Returns the three middleware ports required by composeAuthStack. */
export function createAuthRateLimiters(
  limiter: Pick<RateLimiter, 'consume'>,
  addressPolicy: ClientAddressPolicy,
): AuthLimiterHandlers {
  const ip = clientIp(addressPolicy);
  return {
    login: createRateLimitMiddleware(limiter, { dimensions: [{ operation: 'auth.login.ip', identifier: ip }] }),
    callback: createRateLimitMiddleware(limiter, { dimensions: [{ operation: 'auth.callback.ip', identifier: ip }] }),
    logout: createRateLimitMiddleware(limiter, { dimensions: [{ operation: 'auth.logout.ip', identifier: ip }] }),
    bootstrap: createRateLimitMiddleware(limiter, { dimensions: [{ operation: 'auth.bootstrap.ip', identifier: ip }] }),
  };
}

/** Reusable route middleware for invitation creation and token redemption. */
export function createInvitationRateLimiters(
  limiter: Pick<RateLimiter, 'consume'>,
  addressPolicy: ClientAddressPolicy,
): InvitationLimiterHandlers {
  const ip = clientIp(addressPolicy);
  const principal = (request: Request) => request.principal?.userId ?? null;
  const token = (request: Request) => {
    const body: unknown = request.body;
    if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') return null;
    return body.token;
  };
  return {
    issue: createRateLimitMiddleware(limiter, { dimensions: [
      { operation: 'invitation.issue.ip', identifier: ip },
      { operation: 'invitation.issue.actor', identifier: principal },
    ] }),
    redeem: createRateLimitMiddleware(limiter, { dimensions: [
      { operation: 'invitation.redeem.ip', identifier: ip },
      { operation: 'invitation.redeem.token', identifier: token },
    ] }),
  };
}
