/** The cursor key is independent from authentication, bootstrap and metrics secrets. */
export function loadIssueSearchCursorKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.ISSUE_SEARCH_CURSOR_KEY;
  if (!key) {
    if (env.NODE_ENV === 'production') throw new Error('Issue search cursor key is required in production');
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid issue search cursor key');
  const decoded = Buffer.from(key, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== key
    || key === env.RATE_LIMIT_HMAC_KEY || key === env.OIDC_TRANSACTION_ENCRYPTION_KEY
    || key === env.BOOTSTRAP_GRANT_HASH || key === env.OIDC_CLIENT_SECRET || key === env.METRICS_BEARER_TOKEN) {
    throw new Error('Invalid issue search cursor key');
  }
  return key;
}
