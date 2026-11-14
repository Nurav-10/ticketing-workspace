# Security audit persistence

`writeSecurityAuditEvent(transaction, input)` accepts a Prisma `TransactionClient`, verifies the workspace and current actor membership in workspace-first lock order, validates a closed event/metadata allowlist, and inserts through parameterized SQL. It never starts or commits a transaction. Callers insert audit events in the same transaction as the policy mutation and before deleting the actor's workspace membership, including self-leave. Integration of the mutation paths is in progress and remains unverified.

The migration prevents UPDATE, DELETE, and TRUNCATE; the database assigns `created_at` from `clock_timestamp()` on every insert. Workspace and actor user references use restrictive foreign keys. A trigger validates that a non-null actor belongs to the event workspace at insertion. Later membership removal leaves the audit row and actor user reference intact. Workspace deletion is blocked while events remain; deletion and retention are deferred pending an explicit archive/legal-retention policy.

Metadata is event-specific and contains only canonical UUID identifiers and membership-role enums. It cannot include email, invitation token/hash, credentials, issue text, raw IP, headers, request IDs, or arbitrary text. The JSON validation function and writer allowlist must be updated together when adding an event kind.

## Prisma schema

The active schema contains the following enum and model. SQL constraints/triggers remain authoritative because Prisma does not model the metadata validation function or append-only triggers.

```prisma
enum SecurityAuditEventKind {
  workspace_invitation_created
  workspace_invitation_revoked
  workspace_invitation_redeemed
  workspace_membership_added
  workspace_membership_removed
  workspace_membership_role_changed
  workspace_owner_transferred
  team_created
  team_updated
  team_deleted
  team_membership_added
  team_membership_removed

  @@map("security_audit_event_kind")
}

model SecurityAuditEvent {
  id          String                  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  workspaceId String                  @map("workspace_id") @db.Uuid
  actorUserId String?                 @map("actor_user_id") @db.Uuid
  eventKind   SecurityAuditEventKind  @map("event_kind")
  metadata    Json                    @db.JsonB
  createdAt   DateTime                @default(dbgenerated("clock_timestamp()")) @map("created_at") @db.Timestamptz(6)
  workspace   Workspace              @relation(fields: [workspaceId], references: [id], onDelete: Restrict, map: "security_audit_events_workspace_id_fkey")
  actor       User?                   @relation("SecurityAuditActor", fields: [actorUserId], references: [id], onDelete: Restrict, map: "security_audit_events_actor_user_id_fkey")

  @@index([workspaceId, createdAt(sort: Desc)], map: "security_audit_events_workspace_created_at_idx")
  @@index([actorUserId, createdAt(sort: Desc)], map: "security_audit_events_actor_created_at_idx")
  @@map("security_audit_events")
}
```

`User.securityAuditEvents` and `Workspace.auditEvents` expose the corresponding relations.

## Access and retention

The migration revokes public UPDATE, DELETE, and TRUNCATE grants; append-only triggers also reject those operations. Production should use a separate migration owner and app role, grant the app role only INSERT plus the minimal approved read access, and restrict reads to an approved operations/security role. Table owners and superusers can alter or disable protections, so this is not tamper-proof against privileged database administrators. No audit read endpoint, retention job, export/archive workflow, or compliance claim is included.
