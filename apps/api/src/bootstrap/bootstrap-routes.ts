import type { Request, RequestHandler, Response, Router } from 'express';

export interface BootstrapFlow {
  beginBootstrapLogin(operatorSecret: unknown): Promise<{ transactionHandle: string; authorizationUrl: string }>;
}

export interface BootstrapRouteOptions {
  /** Canonical same-origin HTTPS deployment origin. */
  publicOrigin: string;
  /** Required persistent limiter; configure a dedicated bootstrap operation. */
  rateLimit: RequestHandler;
  /** Keep aligned with the encrypted OIDC transaction lifetime. */
  transactionCookieMaxAgeMs?: number;
}

export const BOOTSTRAP_TRANSACTION_COOKIE_NAME = '__Host-oidc_login_tx';
const cookiePolicy = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };

function sendError(response: Response, request: Request, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message, requestId: request.id } });
}

/** Read a small form body without placing raw body data on parser errors that generic loggers may serialize. */
const readSecretForm: RequestHandler = async (request, response, next) => {
  if (!request.is('application/x-www-form-urlencoded')) {
    sendError(response, request, 415, 'unsupported_media_type', 'Use the bootstrap form');
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024) {
        sendError(response, request, 413, 'request_too_large', 'Request is too large');
        request.destroy();
        return;
      }
      chunks.push(bytes);
    }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const entries = [...fields.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== 'operatorSecret') {
      sendError(response, request, 400, 'invalid_request', 'Request validation failed');
      return;
    }
    response.locals.operatorSecret = entries[0][1];
    next();
  } catch {
    // Never forward parser errors: some include the original request body.
    sendError(response, request, 400, 'invalid_request', 'Request validation failed');
  }
};

/** Registers a guarded operator entry point. Mount only with the dedicated persistent limiter. */
export function registerBootstrapRoutes(router: Router, flow: BootstrapFlow, options: BootstrapRouteOptions): void {
  const origin = new URL(options.publicOrigin);
  const maxAge = options.transactionCookieMaxAgeMs ?? 5 * 60_000;
  if (origin.protocol !== 'https:' || origin.origin !== options.publicOrigin || origin.username || origin.password
    || typeof options.rateLimit !== 'function' || !Number.isSafeInteger(maxAge) || maxAge < 1_000 || maxAge > 15 * 60_000) {
    throw new Error('Invalid bootstrap route configuration');
  }

  router.use((_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });
  router.get('/', (request, response) => {
    if (request.originalUrl.includes('?')) {
      sendError(response, request, 400, 'invalid_request', 'Request validation failed');
      return;
    }
    response.type('html').send('<!doctype html><meta charset="utf-8"><title>First workspace setup</title><h1>First workspace setup</h1><p>Enter the operator secret provided by your deployment administrator.</p><form method="post" action=""><label>Operator secret <input name="operatorSecret" type="password" autocomplete="off" required></label><button type="submit">Continue with sign-in</button></form>');
  });

  const validatePost: RequestHandler = (request, response, next) => {
    if (request.get('origin') !== options.publicOrigin) {
      sendError(response, request, 403, 'origin_rejected', 'Request origin is not allowed');
      return;
    }
    if (request.originalUrl.includes('?')) {
      sendError(response, request, 400, 'invalid_request', 'Request validation failed');
      return;
    }
    next();
  };

  router.post('/', validatePost, options.rateLimit, readSecretForm, async (request, response) => {
    try {
      const started = await flow.beginBootstrapLogin(response.locals.operatorSecret);
      const target = new URL(started.authorizationUrl);
      if (target.protocol !== 'https:' || target.username || target.password || target.hash
        || started.authorizationUrl.includes(String(response.locals.operatorSecret))) {
        sendError(response, request, 503, 'bootstrap_unavailable', 'First workspace setup is currently unavailable');
        return;
      }
      response.cookie(BOOTSTRAP_TRANSACTION_COOKIE_NAME, started.transactionHandle, { ...cookiePolicy, maxAge });
      response.redirect(303, target.href);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'invalid_request') {
        sendError(response, request, 400, 'invalid_request', 'Request validation failed');
        return;
      }
      sendError(response, request, 503, 'bootstrap_unavailable', 'First workspace setup is currently unavailable');
    } finally {
      // Drop the reference as soon as OIDC start has completed; only the grant digest
      // is retained in the provider's encrypted transaction context.
      response.locals.operatorSecret = undefined;
    }
  });
}
