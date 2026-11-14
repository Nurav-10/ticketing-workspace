import { timingSafeEqual } from 'node:crypto';
import type { MetricsAuthorizer } from './metrics.js';

/** The optional bearer token must be an independent, canonical 256-bit secret. */
export function loadMetricsAuthorizer(env: NodeJS.ProcessEnv): MetricsAuthorizer | undefined {
  const token = env.METRICS_BEARER_TOKEN;
  if (token === undefined || token === '') return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid metrics configuration');
  const secret = Buffer.from(token, 'base64url');
  if (secret.length !== 32 || secret.toString('base64url') !== token
    || token === env.RATE_LIMIT_HMAC_KEY || token === env.OIDC_TRANSACTION_ENCRYPTION_KEY
    || token === env.BOOTSTRAP_GRANT_HASH || token === env.OIDC_CLIENT_SECRET) {
    throw new Error('Invalid metrics configuration');
  }
  return (request) => {
    const header = request.get('authorization');
    if (!header?.startsWith('Bearer ')) return false;
    const supplied = header.slice(7);
    if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
    const decoded = Buffer.from(supplied, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === supplied && timingSafeEqual(decoded, secret);
  };
}
