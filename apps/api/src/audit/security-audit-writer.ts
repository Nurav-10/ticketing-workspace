import type { Prisma } from '../generated/prisma/client.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_VALUES = new Set(['owner', 'admin', 'member']);

export type SecurityAuditEventKind =
  | 'workspace_invitation_created'
  | 'workspace_invitation_revoked'
  | 'workspace_invitation_redeemed'
  | 'workspace_membership_added'
  | 'workspace_membership_removed'
  | 'workspace_membership_role_changed'
  | 'workspace_owner_transferred'
  | 'team_created'
  | 'team_updated'
  | 'team_deleted'
  | 'team_membership_added'
  | 'team_membership_removed';

export interface SecurityAuditEventInput {
  workspaceId: string;
  /** Null is reserved for explicitly system-generated events. */
  actorUserId: string | null;
  eventKind: SecurityAuditEventKind;
  metadata: unknown;
}

export class SecurityAuditWriteError extends Error {
  constructor() {
    super('Security audit event could not be recorded');
    this.name = 'SecurityAuditWriteError';
  }
}

type MetadataSpec = { keys: readonly string[]; roles?: readonly string[]; distinctRoleChange?: boolean; distinctOwnerIds?: boolean };

const METADATA_SPECS: Record<SecurityAuditEventKind, MetadataSpec> = {
  workspace_invitation_created: { keys: ['invitation_id'] },
  workspace_invitation_revoked: { keys: ['invitation_id'] },
  workspace_invitation_redeemed: { keys: ['invitation_id'] },
  workspace_membership_added: { keys: ['target_user_id', 'role_after'], roles: ['role_after'] },
  workspace_membership_removed: { keys: ['target_user_id', 'role_before'], roles: ['role_before'] },
  workspace_membership_role_changed: {
    keys: ['target_user_id', 'role_before', 'role_after'],
    roles: ['role_before', 'role_after'],
    distinctRoleChange: true,
  },
  workspace_owner_transferred: {
    keys: ['previous_owner_user_id', 'new_owner_user_id'],
    distinctOwnerIds: true,
  },
  team_created: { keys: ['team_id'] },
  team_updated: { keys: ['team_id'] },
  team_deleted: { keys: ['team_id'] },
  team_membership_added: { keys: ['team_id', 'target_user_id'] },
  team_membership_removed: { keys: ['team_id', 'target_user_id'] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
}

function validateEvent(input: SecurityAuditEventInput): Record<string, string> {
  try {
    if (!input || typeof input.workspaceId !== 'string' || !UUID_PATTERN.test(input.workspaceId)
      || (input.actorUserId !== null && (typeof input.actorUserId !== 'string' || !UUID_PATTERN.test(input.actorUserId)))) {
      throw new SecurityAuditWriteError();
    }
    const spec = Object.hasOwn(METADATA_SPECS, input.eventKind) ? METADATA_SPECS[input.eventKind] : undefined;
    if (!spec || !isRecord(input.metadata)) throw new SecurityAuditWriteError();
    const keys = Reflect.ownKeys(input.metadata);
    const descriptors = Object.getOwnPropertyDescriptors(input.metadata);
    if (keys.some((key) => typeof key !== 'string') || keys.length !== spec.keys.length
      || spec.keys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
      throw new SecurityAuditWriteError();
    }
    const safeMetadata: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      const value: unknown = descriptor?.value;
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof value !== 'string') {
        throw new SecurityAuditWriteError();
      }
      if (key.endsWith('_id') && !UUID_PATTERN.test(value)) throw new SecurityAuditWriteError();
      if (spec.roles?.includes(key) && !ROLE_VALUES.has(value)) throw new SecurityAuditWriteError();
      safeMetadata[key] = value;
    }
    if (spec.distinctRoleChange && safeMetadata.role_before === safeMetadata.role_after) {
      throw new SecurityAuditWriteError();
    }
    if (spec.distinctOwnerIds && safeMetadata.previous_owner_user_id === safeMetadata.new_owner_user_id) {
      throw new SecurityAuditWriteError();
    }
    return safeMetadata;
  } catch {
    throw new SecurityAuditWriteError();
  }
}

/**
 * Adds an immutable audit event inside the caller's existing Prisma transaction.
 * Call before a membership removal, including a self-leave, and keep the policy
 * mutation and this insert in the same transaction so either both commit or neither.
 */
export async function writeSecurityAuditEvent(
  transaction: Prisma.TransactionClient,
  input: SecurityAuditEventInput,
): Promise<string> {
  const metadata = validateEvent(input);
  try {
    // Global lock order is workspace, then actor membership. Mutating operations
    // should follow the same order before invoking this writer to avoid inversion.
    const workspaces = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id
      FROM workspaces
      WHERE id = ${input.workspaceId}::uuid
      FOR KEY SHARE
    `;
    if (workspaces.length !== 1) throw new SecurityAuditWriteError();

    if (input.actorUserId !== null) {
      const memberships = await transaction.$queryRaw<Array<{ userId: string }>>`
        SELECT user_id::text AS "userId"
        FROM workspace_memberships
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND user_id = ${input.actorUserId}::uuid
        FOR KEY SHARE
      `;
      if (memberships.length !== 1) throw new SecurityAuditWriteError();
    }

    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      INSERT INTO security_audit_events (workspace_id, actor_user_id, event_kind, metadata)
      VALUES (
        ${input.workspaceId}::uuid,
        ${input.actorUserId}::uuid,
        ${input.eventKind}::security_audit_event_kind,
        ${JSON.stringify(metadata)}::jsonb
      )
      RETURNING id::text AS id
    `;
    const id = rows[0]?.id;
    if (!id) throw new SecurityAuditWriteError();
    return id;
  } catch {
    // Do not surface SQL parameters, metadata, or database details to callers.
    throw new SecurityAuditWriteError();
  }
}
