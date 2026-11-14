import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AuthFlowError } from './auth-flow-service.js';
import { AuthFlowService } from './auth-flow-service.js';

export const OIDC_TRANSACTION_COOKIE_NAME = '__Host-oidc_login_tx';

export interface AuthRouteOptions {
  publicOrigin: string;
  callbackUri: string;
  sessionCookieName: string;
  transactionCookieMaxAgeMs?: number;
}

const loginBody = z.object({
  invitationToken: z.string().min(43).max(43).optional(),
}).strict();

const cookiePolicy = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

function writeError(response: Response, request: Request, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message, requestId: request.id } });
}

function flowErrorResponse(error: AuthFlowError): { status: number; code: string; message: string } {
  if (error.code === 'invalid_request') return { status: 400, code: 'invalid_request', message: 'Request validation failed' };
  if (error.code === 'rejected') return { status: 401, code: 'login_rejected', message: 'Sign-in could not be completed' };
  return { status: 503, code: 'login_unavailable', message: 'Sign-in is currently unavailable' };
}

function callbackUrlFromTrustedBase(request: Request, callbackUri: string): URL {
  const callback = new URL(callbackUri);
  const queryIndex = request.originalUrl.indexOf('?');
  callback.search = queryIndex < 0 ? '' : request.originalUrl.slice(queryIndex);
  return callback;
}

function transactionCookieOptions(maxAge: number) {
  return { ...cookiePolicy, maxAge };
}

/** Registers a transport adapter; the parent app must mount it on the configured callback path. */
export function registerAuthRoutes(router: Router, flow: AuthFlowService, options: AuthRouteOptions): void {
  const publicOrigin = new URL(options.publicOrigin);
  const callback = new URL(options.callbackUri);
  const sessionCookieName = options.sessionCookieName;
  const transactionCookieMaxAgeMs = options.transactionCookieMaxAgeMs ?? 5 * 60_000;
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== options.publicOrigin
    || callback.protocol !== 'https:' || callback.href !== options.callbackUri
    || !/^__Host-[A-Za-z0-9_-]+$/.test(sessionCookieName) || sessionCookieName === OIDC_TRANSACTION_COOKIE_NAME
    || !Number.isSafeInteger(transactionCookieMaxAgeMs)
    || transactionCookieMaxAgeMs < 1_000 || transactionCookieMaxAgeMs > 15 * 60_000) {
    throw new Error('Invalid auth route configuration');
  }

  const setResponseHeaders = (_request: Request, response: Response, next: (error?: unknown) => void) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    next();
  };
  const issueRedirect = async (request: Request, response: Response, invitationToken?: unknown) => {
    try {
      const started = await flow.beginLogin(invitationToken);
      const target = new URL(started.authorizationUrl);
      if (target.protocol !== 'https:' || target.username || target.password || target.hash
        || (typeof invitationToken === 'string' && started.authorizationUrl.includes(invitationToken))) {
        writeError(response, request, 503, 'login_unavailable', 'Sign-in is currently unavailable');
        return;
      }
      response.cookie(OIDC_TRANSACTION_COOKIE_NAME, started.transactionHandle, transactionCookieOptions(transactionCookieMaxAgeMs));
      response.redirect(303, target.href);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && 'name' in error && error.name === 'AuthFlowError') {
        const mapped = flowErrorResponse(error as AuthFlowError);
        writeError(response, request, mapped.status, mapped.code, mapped.message);
        return;
      }
      writeError(response, request, 503, 'login_unavailable', 'Sign-in is currently unavailable');
    }
  };

  router.use(setResponseHeaders);
  router.get('/login', async (request, response) => {
    // GET login has no user-supplied query options; invitation tokens must be POSTed in the body.
    if (request.originalUrl.includes('?')) {
      writeError(response, request, 400, 'invalid_request', 'Request validation failed');
      return;
    }
    const origin = request.get('origin');
    if (origin !== undefined && origin !== options.publicOrigin) {
      writeError(response, request, 403, 'origin_rejected', 'Request origin is not allowed');
      return;
    }
    await issueRedirect(request, response);
  });

  router.post('/login', express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 8 }), async (request, response) => {
    if (request.get('origin') !== options.publicOrigin) {
      writeError(response, request, 403, 'origin_rejected', 'Request origin is not allowed');
      return;
    }
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      writeError(response, request, 400, 'invalid_request', 'Request validation failed');
      return;
    }
    await issueRedirect(request, response, parsed.data.invitationToken);
  });

  router.post('/logout', async (request, response) => {
    if (request.get('origin') !== options.publicOrigin) {
      writeError(response, request, 403, 'origin_rejected', 'Request origin is not allowed');
      return;
    }
    if (request.originalUrl.includes('?')) {
      writeError(response, request, 400, 'invalid_request', 'Request validation failed');
      return;
    }
    const token: unknown = request.cookies?.[sessionCookieName];
    if (typeof token !== 'string') {
      response.clearCookie(sessionCookieName, cookiePolicy);
      response.status(204).end();
      return;
    }
    try {
      await flow.revokeIssuedSession(token);
      response.clearCookie(sessionCookieName, cookiePolicy);
      response.status(204).end();
    } catch {
      writeError(response, request, 503, 'logout_unavailable', 'Sign-out is currently unavailable');
    }
  });

  router.get('/callback', async (request, response) => {
    const transactionHandle: unknown = request.cookies?.[OIDC_TRANSACTION_COOKIE_NAME];
    try {
      const result = await flow.completeLogin(
        callbackUrlFromTrustedBase(request, options.callbackUri),
        typeof transactionHandle === 'string' ? transactionHandle : undefined,
      );
      const idleExpiry = result.session.idleExpiresAt.getTime();
      const absoluteExpiry = result.session.absoluteExpiresAt.getTime();
      if (!Number.isFinite(idleExpiry) || !Number.isFinite(absoluteExpiry)
        || idleExpiry <= Date.now() || idleExpiry > absoluteExpiry) {
        await flow.revokeIssuedSession(result.session.token).catch(() => undefined);
        response.clearCookie(OIDC_TRANSACTION_COOKIE_NAME, cookiePolicy);
        writeError(response, request, 503, 'login_unavailable', 'Sign-in is currently unavailable');
        return;
      }
      response.clearCookie(OIDC_TRANSACTION_COOKIE_NAME, cookiePolicy);
      // The server refreshes idle expiry on activity; the browser cookie must last
      // until the absolute deadline while every request still enforces idle expiry.
      response.cookie(sessionCookieName, result.session.token, { ...cookiePolicy, expires: new Date(absoluteExpiry) });
      response.redirect(303, new URL('/', options.publicOrigin).href);
    } catch (error) {
      response.clearCookie(OIDC_TRANSACTION_COOKIE_NAME, cookiePolicy);
      if (error && typeof error === 'object' && 'code' in error && 'name' in error && error.name === 'AuthFlowError') {
        const mapped = flowErrorResponse(error as AuthFlowError);
        writeError(response, request, mapped.status, mapped.code, mapped.message);
        return;
      }
      writeError(response, request, 401, 'login_rejected', 'Sign-in could not be completed');
    }
  });
}
