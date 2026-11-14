# API foundation

Run the API with Node 24 after installing the workspace through the repository's Docker workflow. Useful scripts are `dev`, `build`, `start`, `migrate`, `test`, `test:integration` and `typecheck`. `PUBLIC_ORIGIN` is required and must be an exact origin such as `https://app.example`; unsafe authenticated requests reject a missing or different `Origin`. `TRUST_PROXY` defaults to false and production currently rejects enabling it until a bounded proxy allowlist is implemented.

The selected identity provider is intentionally not configured. Protected requests use a fail-closed adapter, and production startup refuses that adapter. The API does not implement sign-in, cookie issuance/logout, invitation creation/revocation, or a real provider session verifier. Invitation redemption is a persistence/service seam only; creating invitations requires an issuer authorization policy first.

Integration tests require `TEST_DATABASE_URL` and accept only the Compose service host `db-test` on port 5432, database `ticketing_test`, and role `ticketing_test` (hostname comparison is case-insensitive). The guard also rejects a target matching `DATABASE_URL` by host, effective port, and database name even when credentials differ. The suite applies SQL migrations through the production migration runner before exercising schema constraints and invitation transactions. Never point it at development or production data.

`PUBLIC_ORIGIN` must be an exact HTTP or HTTPS origin. Production requires HTTPS.

Workspace listing and invitation redemption are implemented. Team visibility, private-team access, workspace issuer permissions, role changes, last-owner transfer, invitation issuance, rate limiting, and staging/production deployment remain unresolved or unimplemented. This is a partial Phase 1 foundation, not a complete identity or authorization system.
