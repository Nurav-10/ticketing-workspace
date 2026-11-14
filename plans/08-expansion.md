# Phase 8 — Post-launch expansion

**Goal:** prioritize enhancements from beta evidence. Each selected item needs its own specification, risk review and acceptance gate.

## 8.1 Integrations

Design inbound webhooks with signature verification, replay protection, idempotency and a durable inbox. Design outbound webhooks with per-endpoint secrets, bounded retries, backoff and delivery logs that omit sensitive bodies by default. Add source-control issue linking only after defining authority, conflicts, permissions, revocation and a provider adapter.

## 8.2 Attachments and richer editing

Use private object storage, authorized short-lived upload/download URLs, size/type checks, scanning/quarantine policy, abandoned-upload cleanup and defined retention/deletion. Test cross-tenant object access and expired links. Evaluate a richer editor only after defining sanitization, paste behavior, accessibility, storage format and migration.

## 8.3 Advanced workflows

Consider dependencies, sub-issues, recurring issues, advanced reporting, imports/exports, public API, custom roles, enterprise SSO/SCIM and a customer portal. Each has separate identity, permission and migration implications.

Consider AI assistance only with explicit data handling, user consent, auditability, permission filtering and human control over actions. Full offline editing needs an explicit conflict-resolution model and is not implied by optimistic UI.

**Acceptance / exit:** every selected enhancement has a documented user value, owner, cost, authorization boundary and observable tests. Unselected ideas remain backlog.
