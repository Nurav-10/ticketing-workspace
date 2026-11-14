# Shared API Rate Limits

## Boundary

This slice provides a database-backed counter service for sensitive operations. The in-progress startup wiring applies explicit IP limits to login, callback and logout, and IP plus actor or token limits to invitation issue and redemption. Bootstrap remains an internal-only flow and needs its own limiting before any operator entry point is exposed. Callers make one `consume(operation, identifier)` call for each configured dimension. Identifiers are HMAC-SHA-256 digests; raw IPs, emails, invitation data, and secrets never reach PostgreSQL or logs.

The service requires a dedicated 32-byte server secret for identifier HMAC. It must be independent from session, cookie, OIDC encryption, and bootstrap secrets. There is no default or fallback. Each operation has an explicit bounded fixed-window duration, count limit, and post-window retention.

## Window and atomicity semantics

Windows are fixed UTC/Unix-epoch-aligned intervals. PostgreSQL `clock_timestamp()` selects the current window and a single `INSERT ... ON CONFLICT DO UPDATE` atomically increments its count, so simultaneous API instances share one counter. After the upsert (and any row-lock wait), the repository checks DB time again. If the request crossed a boundary while waiting, it conservatively charges the new bucket too and retries a bounded number of times; if DB time keeps advancing, it fails closed. A request is allowed when the resulting count is at or below its configured limit. The returned retry delay is derived from the database clock and current window end. Storage failures fail closed with a blocked decision; no caller should infer a successful check when persistence is unavailable.

Each row contains operation, a 32-byte HMAC identifier, window start/size, count, and expiry. It never contains the source identifier or HMAC key. Cleanup removes rows after `window end + retention` in deterministic batches of at most 5,000 rows; invoke it repeatedly from scheduled maintenance until a batch removes fewer than the requested size. Retention is finite and configured per operation. A policy window-size change starts a new bucket namespace and can reset that operation's current budget.

## Client IP and proxy trust

When proxy trust is disabled, derive the client address solely from the socket peer and ignore `X-Forwarded-For` entirely. When enabled, require an explicit exact-IP allowlist for trusted proxy peers plus a small maximum forwarded-hop count. Walk the chain from the socket peer right-to-left, skipping only allowlisted proxies and selecting the first untrusted IP. Each trusted proxy must append the actual peer address to the forwarded chain; do not trust proxies that preserve an untrusted client-supplied rightmost value. Invalid, oversized, or malformed forwarding chains fall back to the socket peer; an untrusted socket peer never gains authority from a forwarded header. Do not enable Express `trust proxy` globally based on a boolean alone.

The initial deployment policy remains proxy-untrusted unless networking supplies a reviewed stable proxy allowlist. Configuring request identifiers at route boundaries stays a separate integration responsibility.

## Failures and privacy

Malformed service configuration is rejected at construction. Unknown operations and malformed identifiers fail closed. Counter storage errors return a generic blocked decision with a bounded retry delay; the service does not log identifiers, secret material, hashes, or database errors. A higher-level service may emit only redacted outcome metrics. Route responses should remain generic and must not reveal whether an IP, account, or operation bucket caused denial.

## Retention and key rotation

Cleanup is required operational maintenance; expired rows are safe to delete because they cannot affect a current window. Run it periodically and monitor row count and cleanup errors. HMAC key rotation changes every identifier digest and therefore starts fresh buckets; coordinate rotation as a security-sensitive reset of active rate budgets, deploy the new independent secret consistently across instances, then let old rows expire and clean them. Never dual-log or store the old/new secret. If seamless no-reset rotation is later needed, add explicit key-version overlap and atomically charge every active version before enabling it.

## Tests and wiring

Unit tests cover configuration validation, HMAC separation, decisions, fail-closed storage behavior, middleware, and proxy-header trust. Guarded PostgreSQL integration tests cover cross-connection concurrent increments, fixed-window boundaries based on database time, and cleanup. These tests are authored but have not yet run; execute them only under the repository's guarded integration database harness. Startup wiring and operational limits also require Docker verification before they are considered complete.
