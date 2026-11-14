import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { ApiError } from '../shared/api-error.js';
import type { Authenticator } from '../auth/authenticator.js';

export function createRequestId(request: Request): string {
  const supplied = request.headers['x-request-id'];
  return typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : randomUUID();
}

export async function authenticateAndCheckOrigin(
  request: Request,
  authenticator: Authenticator,
  sessionCookieName: string,
  publicOrigin: string
): Promise<void> {
  request.principal = await authenticator.authenticate(request, sessionCookieName);
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (unsafe && request.principal && request.get('origin') !== publicOrigin) {
    throw new ApiError(403, 'origin_rejected', 'Request origin is not allowed');
  }
}
