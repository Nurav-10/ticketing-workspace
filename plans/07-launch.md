# Phase 7 — Reliability, security and launch

**Goal:** make the agreed beta supportable and measurable. Begin this work alongside earlier phases; this is the final release gate.

## 7.1 Security and data handling

Review threats for authentication, authorization, tenant isolation, injection, XSS, CSRF, secrets, file access, abuse and supply chain. Verify role matrices across API, search, streams, worker and notifications. Rate-limit login, invitations and expensive reads with documented proxy and user/IP assumptions.

Use secure cookies, transport encryption, safe headers/content policies, least-privilege service identities and documented secret rotation. Review vendors and residency. Run dependency and container scans; record accepted risks, owners and remediation.

## 7.2 Recovery and operations

Document environments, deployment, migration order, rollback compatibility, worker drain/retry, on-call ownership, alerts and runbooks. Monitor request rate/errors/latency, database saturation and pool, job lag and SSE disconnects.

Schedule encrypted backups and perform an actual restore into an isolated environment. Agree RPO/RTO and retain evidence of the restore. Rehearse migrations, forward recovery and rollback using realistic data.

## 7.3 Quality, accessibility and performance

Exercise the full journey with multiple users and isolated workspaces, including denied access, stale edits, retries, expiry, reconnect and DB/worker interruption. Check supported browsers, keyboard, screen readers, responsive layouts, reduced motion, contrast and focus.

Load-test lists/search, issue writes, worker backlog and SSE with the agreed data and concurrency. Record hardware, data size, traffic mix, cache state and thresholds before measurement. Compare with the provisional budgets in plan.md and revise from evidence.

## 7.4 Beta and release

Run a limited beta with a support channel and feedback owners. Triage defects and observe actual performance. Do not release with unresolved critical tenant isolation, data loss or recovery defects. Before production deployment, name owners and record evidence for migration/rollback, restore, monitoring, incident response, accessibility and security.

**Acceptance / exit:** a named owner signs off each gate; representative restore and rollback succeeded; no critical isolation/data-loss issue remains; latency and error goals are measured under recorded conditions. External claims match actual evidence.
