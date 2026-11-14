# Phase 1 security audit persistence foundation

## Scope

Add append-only PostgreSQL storage and a transaction-bound Prisma writer. The in-progress implementation integrates events into bootstrap, invitation provisioning, and workspace, membership and team mutations. It does not add audit read endpoints or UI. The Prisma schema models the storage; SQL remains authoritative for database-only protections.

## Data contract

- Each event stores a database-generated UUID and `clock_timestamp()` timestamp, workspace UUID, optional actor user UUID, one enumerated event kind, and JSONB metadata.
- The workspace FK uses `ON DELETE RESTRICT`, preserving history until an explicit retention/archive and workspace deletion design exists.
- An actor FK references `users` with `ON DELETE RESTRICT`. A database insert trigger takes a key-share lock and verifies a non-null actor is currently a member of the same workspace. The writer repeats this check through the caller's transaction for an early, generic failure. This permits later membership removal without mutating prior audit rows; it does not claim a durable membership FK.
- Metadata is event-specific and limited to UUID identifiers and role enums. Event names and constraints reject extra fields, email, invitation tokens, credentials, issue content, raw IPs, headers, and arbitrary text.
- PostgreSQL triggers reject UPDATE, DELETE, and TRUNCATE. The insert trigger owns timestamp generation and membership validation.

## Transaction and ownership rules

`writeSecurityAuditEvent(transaction, input)` accepts a Prisma `TransactionClient`; it never opens or commits a transaction. A policy service must call it in the same transaction as the mutation and before deleting an actor's workspace membership. A failed audit insert aborts that surrounding transaction so the policy change cannot commit without its event.

The database role that owns the table can disable triggers or alter grants, so production must separate migration ownership from the application role, grant the application role INSERT and SELECT only, and restrict audit reads to approved security/operations roles. No read API is included here.

## Migration safety

Migration `20261114000600_security_audit` is additive: it creates a new enum, validation function, table, indexes, and triggers. It changes no existing rows or tables. It deliberately blocks workspace and actor-user deletion while retained audit rows reference them. Workspace deletion remains a deferred feature until retention, archival, and legal deletion rules are decided.

## Verification cases

- Unit: accept each declared event/metadata shape; reject unknown event kinds, unknown or sensitive fields, malformed UUIDs, invalid/equal role transitions, and missing workspace actors without attempting insertion.
- Integration: write through an existing Prisma transaction, assert database-generated time and scoped actor validity, assert metadata CHECKs and immutable UPDATE/DELETE/TRUNCATE triggers, verify removing a workspace membership leaves its audit event, and verify deleting a referenced workspace is rejected.

These tests are authored with this slice but not executed under the current instruction. Transactional service integration also requires Docker verification. No retention policy, read authorization, tamper-evident hash chain, or external audit delivery guarantee is claimed.
