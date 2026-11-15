import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import {
  WorkflowDomainError,
  isUuid,
  type NormalizedCreateStatusCommand,
  type NormalizedRetireStatusCommand,
  type NormalizedUpdateStatusCommand,
  type WorkflowConfiguration,
  type WorkflowScope,
  type WorkflowStatusCategory,
  type WorkflowStatusSummary,
  type WorkflowTransitionSummary,
} from './workflow-domain.js';
import type { AddTransitionCommand, DeleteTransitionCommand, WorkflowRepository } from './workflow-repository.js';
import type { WorkflowPort } from './workflow-port.js';

interface LockedTeam {
  id: string;
  workflow_version: number;
}

interface RawStatusRow {
  id: string;
  workspace_id: string;
  team_id: string;
  key: string;
  name: string;
  category: WorkflowStatusCategory;
  position: number;
  is_default: boolean;
  is_retired: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RawTransitionRow {
  id: string;
  workspace_id: string;
  team_id: string;
  source_status_id: string;
  target_status_id: string;
  created_at: Date;
}

function mapStatusRow(row: RawStatusRow): WorkflowStatusSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    key: row.key,
    name: row.name,
    category: row.category,
    position: row.position,
    isDefault: row.is_default,
    isRetired: row.is_retired,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransitionRow(row: RawTransitionRow): WorkflowTransitionSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    sourceStatusId: row.source_status_id,
    targetStatusId: row.target_status_id,
    createdAt: row.created_at,
  };
}

function categoryToLegacyStatus(category: WorkflowStatusCategory, key: string): string {
  const legacyStatuses = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
  if (legacyStatuses.includes(key)) return key;
  switch (category) {
    case 'backlog': return 'backlog';
    case 'unstarted': return 'todo';
    case 'started': return 'in_progress';
    case 'completed': return 'done';
    case 'canceled': return 'canceled';
  }
}

export class PrismaWorkflowRepository implements WorkflowRepository, WorkflowPort {
  constructor(private readonly prisma: PrismaClient) {}

  async getWorkflow(scope: WorkflowScope): Promise<WorkflowConfiguration> {
    const teams = await this.prisma.$queryRaw<LockedTeam[]>`
      SELECT id::text AS id, workflow_version
      FROM teams
      WHERE workspace_id = ${scope.workspaceId}::uuid AND id = ${scope.teamId}::uuid
    `;
    const team = teams[0];
    if (!team) {
      throw new WorkflowDomainError('workflow_not_found', 'Team or workspace not found');
    }

    const statuses = await this.prisma.$queryRaw<RawStatusRow[]>`
      SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
             key, name, category, position, is_default, is_retired, created_at, updated_at
      FROM workflow_statuses
      WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid
      ORDER BY position ASC, id ASC
    `;

    const transitions = await this.prisma.$queryRaw<RawTransitionRow[]>`
      SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
             source_status_id::text AS source_status_id, target_status_id::text AS target_status_id,
             created_at
      FROM workflow_transitions
      WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid
      ORDER BY created_at ASC, id ASC
    `;

    return {
      version: team.workflow_version,
      statuses: statuses.map(mapStatusRow),
      transitions: transitions.map(mapTransitionRow),
    };
  }

  async listStatuses(scope: WorkflowScope, includeRetired = false): Promise<WorkflowStatusSummary[]> {
    const statuses = await this.prisma.$queryRaw<RawStatusRow[]>`
      SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
             key, name, category, position, is_default, is_retired, created_at, updated_at
      FROM workflow_statuses
      WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid
        ${includeRetired ? Prisma.empty : Prisma.sql`AND is_retired = false`}
      ORDER BY position ASC, id ASC
    `;
    return statuses.map(mapStatusRow);
  }

  async getStatus(scope: WorkflowScope, statusId: string): Promise<WorkflowStatusSummary | null> {
    if (!isUuid(statusId)) return null;
    const rows = await this.prisma.$queryRaw<RawStatusRow[]>`
      SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
             key, name, category, position, is_default, is_retired, created_at, updated_at
      FROM workflow_statuses
      WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid AND id = ${statusId}::uuid
      LIMIT 1
    `;
    return rows[0] ? mapStatusRow(rows[0]) : null;
  }

  async getStatusByKey(scope: WorkflowScope, key: string): Promise<WorkflowStatusSummary | null> {
    const rows = await this.prisma.$queryRaw<RawStatusRow[]>`
      SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
             key, name, category, position, is_default, is_retired, created_at, updated_at
      FROM workflow_statuses
      WHERE workspace_id = ${scope.workspaceId}::uuid AND team_id = ${scope.teamId}::uuid AND key = ${key}
      LIMIT 1
    `;
    return rows[0] ? mapStatusRow(rows[0]) : null;
  }

  async createStatus(command: NormalizedCreateStatusCommand): Promise<{ status: WorkflowStatusSummary; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorkspace(tx, command.workspaceId);
      const team = await this.lockTeam(tx, command.workspaceId, command.teamId);
      this.assertVersion(team.workflow_version, command.expectedVersion);

      const existingKey = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM workflow_statuses
        WHERE team_id = ${command.teamId}::uuid AND key = ${command.key}
      `;
      if (existingKey.length > 0) {
        throw new WorkflowDomainError('workflow_key_exists', `A status with key '${command.key}' already exists in this team`);
      }

      let position = command.position;
      if (position === undefined) {
        const maxPosRow = await tx.$queryRaw<{ next_pos: number }[]>`
          SELECT COALESCE(MAX(position), -1) + 1 AS next_pos
          FROM workflow_statuses
          WHERE team_id = ${command.teamId}::uuid AND is_retired = false
        `;
        position = maxPosRow[0]?.next_pos ?? 0;
      } else {
        await tx.$executeRaw`
          UPDATE workflow_statuses
          SET position = position + 1000000
          WHERE workspace_id = ${command.workspaceId}::uuid
            AND team_id = ${command.teamId}::uuid
            AND is_retired = false
            AND position >= ${position}
        `;
        await tx.$executeRaw`
          UPDATE workflow_statuses
          SET position = position - 999999
          WHERE workspace_id = ${command.workspaceId}::uuid
            AND team_id = ${command.teamId}::uuid
            AND is_retired = false
            AND position >= 1000000
        `;
      }

      if (command.isDefault) {
        await tx.$executeRaw`
          UPDATE workflow_statuses
          SET is_default = false
          WHERE workspace_id = ${command.workspaceId}::uuid
            AND team_id = ${command.teamId}::uuid
            AND is_default = true
        `;
      }

      const inserted = await tx.$queryRaw<RawStatusRow[]>`
        INSERT INTO workflow_statuses(workspace_id, team_id, key, name, category, position, is_default, is_retired)
        VALUES (${command.workspaceId}::uuid, ${command.teamId}::uuid, ${command.key}, ${command.name},
                ${command.category}::workflow_status_category, ${position}, ${command.isDefault}, false)
        RETURNING id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
                  key, name, category, position, is_default, is_retired, created_at, updated_at
      `;

      const nextVersion = team.workflow_version + 1;
      await tx.$executeRaw`
        UPDATE teams
        SET workflow_version = ${nextVersion}
        WHERE workspace_id = ${command.workspaceId}::uuid AND id = ${command.teamId}::uuid
      `;

      return {
        status: mapStatusRow(inserted[0]!),
        version: nextVersion,
      };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async updateStatus(command: NormalizedUpdateStatusCommand): Promise<{ status: WorkflowStatusSummary; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorkspace(tx, command.workspaceId);
      const team = await this.lockTeam(tx, command.workspaceId, command.teamId);
      this.assertVersion(team.workflow_version, command.expectedVersion);

      const statusRows = await tx.$queryRaw<RawStatusRow[]>`
        SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
               key, name, category, position, is_default, is_retired, created_at, updated_at
        FROM workflow_statuses
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND id = ${command.statusId}::uuid
        FOR UPDATE
      `;
      const current = statusRows[0];
      if (!current) {
        throw new WorkflowDomainError('workflow_not_found', 'Status not found');
      }
      if (current.is_retired) {
        throw new WorkflowDomainError('workflow_status_retired', 'Cannot modify a retired status');
      }

      if (command.changes.isDefault === false && current.is_default) {
        throw new WorkflowDomainError(
          'workflow_default_invariant_violated',
          'A team must have at least one default status; designate another default status first',
        );
      }

      if (command.changes.isDefault === true && !current.is_default) {
        await tx.$executeRaw`
          UPDATE workflow_statuses
          SET is_default = false
          WHERE workspace_id = ${command.workspaceId}::uuid
            AND team_id = ${command.teamId}::uuid
            AND id <> ${command.statusId}::uuid
            AND is_default = true
        `;
      }

      const nextName = command.changes.name ?? current.name;
      const nextCategory = command.changes.category ?? current.category;
      const nextDefault = command.changes.isDefault !== undefined ? command.changes.isDefault : current.is_default;
      let nextPosition = current.position;

      if (command.changes.position !== undefined && command.changes.position !== current.position) {
        nextPosition = command.changes.position;
        const targetPos = nextPosition;
        if (targetPos > current.position) {
          await tx.$executeRaw`
            UPDATE workflow_statuses
            SET position = position - 1
            WHERE workspace_id = ${command.workspaceId}::uuid
              AND team_id = ${command.teamId}::uuid
              AND is_retired = false
              AND position > ${current.position}
              AND position <= ${targetPos}
          `;
        } else {
          await tx.$executeRaw`
            UPDATE workflow_statuses
            SET position = position + 1000000
            WHERE workspace_id = ${command.workspaceId}::uuid
              AND team_id = ${command.teamId}::uuid
              AND is_retired = false
              AND position >= ${targetPos}
              AND position < ${current.position}
          `;
          await tx.$executeRaw`
            UPDATE workflow_statuses
            SET position = position - 999999
            WHERE workspace_id = ${command.workspaceId}::uuid
              AND team_id = ${command.teamId}::uuid
              AND is_retired = false
              AND position >= 1000000
          `;
        }
      }

      const updated = await tx.$queryRaw<RawStatusRow[]>`
        UPDATE workflow_statuses
        SET name = ${nextName},
            category = ${nextCategory}::workflow_status_category,
            position = ${nextPosition},
            is_default = ${nextDefault},
            updated_at = clock_timestamp()
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND id = ${command.statusId}::uuid
        RETURNING id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
                  key, name, category, position, is_default, is_retired, created_at, updated_at
      `;

      const nextVersion = team.workflow_version + 1;
      await tx.$executeRaw`
        UPDATE teams
        SET workflow_version = ${nextVersion}
        WHERE workspace_id = ${command.workspaceId}::uuid AND id = ${command.teamId}::uuid
      `;

      return {
        status: mapStatusRow(updated[0]!),
        version: nextVersion,
      };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async retireStatus(command: NormalizedRetireStatusCommand): Promise<{ retiredStatusId: string; reassignedCount: number; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorkspace(tx, command.workspaceId);
      const team = await this.lockTeam(tx, command.workspaceId, command.teamId);
      this.assertVersion(team.workflow_version, command.expectedVersion);

      const statusRows = await tx.$queryRaw<RawStatusRow[]>`
        SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
               key, name, category, position, is_default, is_retired, created_at, updated_at
        FROM workflow_statuses
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND id = ${command.statusId}::uuid
        FOR UPDATE
      `;
      const current = statusRows[0];
      if (!current) {
        throw new WorkflowDomainError('workflow_not_found', 'Status not found');
      }
      if (current.is_retired) {
        throw new WorkflowDomainError('workflow_status_retired', 'Status is already retired');
      }
      if (current.is_default) {
        throw new WorkflowDomainError(
          'workflow_default_invariant_violated',
          'Cannot retire the default status; designate another default status first',
        );
      }

      const targetRows = await tx.$queryRaw<RawStatusRow[]>`
        SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
               key, name, category, position, is_default, is_retired, created_at, updated_at
        FROM workflow_statuses
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND id = ${command.targetStatusId}::uuid
        FOR UPDATE
      `;
      const target = targetRows[0];
      if (!target) {
        throw new WorkflowDomainError('workflow_reassignment_target_invalid', 'Reassignment target status not found');
      }
      if (target.is_retired) {
        throw new WorkflowDomainError('workflow_reassignment_target_invalid', 'Cannot reassign issues to a retired status');
      }
      if (target.id === current.id) {
        throw new WorkflowDomainError('workflow_reassignment_target_invalid', 'Cannot reassign issues to the status being retired');
      }

      const legacyStatus = categoryToLegacyStatus(target.category, target.key);

      const affectedIssues = await tx.$queryRaw<{ id: string; version: number }[]>`
        SELECT id::text AS id, version
        FROM issues
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND (workflow_status_id = ${current.id}::uuid OR (workflow_status_id IS NULL AND status::text = ${current.key}))
        FOR UPDATE
      `;

      if (affectedIssues.length > 0) {
        await tx.$executeRaw`
          UPDATE issues
          SET workflow_status_id = ${target.id}::uuid,
              status = ${legacyStatus}::issue_status,
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE workspace_id = ${command.workspaceId}::uuid
            AND team_id = ${command.teamId}::uuid
            AND (workflow_status_id = ${current.id}::uuid OR (workflow_status_id IS NULL AND status::text = ${current.key}))
        `;

        const currentLegacyStatus = categoryToLegacyStatus(current.category, current.key);
        for (const issue of affectedIssues) {
          const activityMetadata = {
            statusBefore: currentLegacyStatus,
            statusAfter: legacyStatus,
          };
          await tx.$executeRaw`
            INSERT INTO issue_activity_events(workspace_id, team_id, issue_id, actor_user_id, event_kind, metadata)
            VALUES (${command.workspaceId}::uuid, ${command.teamId}::uuid, ${issue.id}::uuid,
                    ${command.actorUserId}::uuid, 'status_changed'::issue_activity_kind, ${activityMetadata}::jsonb)
          `;
          const outboxPayload = {
            issue_id: issue.id,
            version: issue.version + 1,
          };
          await tx.$executeRaw`
            INSERT INTO outbox_events(workspace_id, team_id, issue_id, event_kind, payload)
            VALUES (${command.workspaceId}::uuid, ${command.teamId}::uuid, ${issue.id}::uuid,
                    'issue.updated', ${outboxPayload}::jsonb)
          `;
        }
      }

      await tx.$executeRaw`
        DELETE FROM workflow_transitions
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND (source_status_id = ${current.id}::uuid OR target_status_id = ${current.id}::uuid)
      `;

      await tx.$executeRaw`
        UPDATE workflow_statuses
        SET is_retired = true,
            is_default = false,
            updated_at = clock_timestamp()
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND id = ${current.id}::uuid
      `;

      const nextVersion = team.workflow_version + 1;
      await tx.$executeRaw`
        UPDATE teams
        SET workflow_version = ${nextVersion}
        WHERE workspace_id = ${command.workspaceId}::uuid AND id = ${command.teamId}::uuid
      `;

      return {
        retiredStatusId: current.id,
        reassignedCount: affectedIssues.length,
        version: nextVersion,
      };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async addTransition(command: AddTransitionCommand): Promise<{ transition: WorkflowTransitionSummary; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorkspace(tx, command.workspaceId);
      const team = await this.lockTeam(tx, command.workspaceId, command.teamId);
      this.assertVersion(team.workflow_version, command.expectedVersion);

      const statuses = await tx.$queryRaw<RawStatusRow[]>`
        SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
               key, name, category, position, is_default, is_retired, created_at, updated_at
        FROM workflow_statuses
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND id IN (${command.sourceStatusId}::uuid, ${command.targetStatusId}::uuid)
      `;
      const source = statuses.find((s) => s.id === command.sourceStatusId);
      const target = statuses.find((s) => s.id === command.targetStatusId);

      if (!source || !target) {
        throw new WorkflowDomainError('workflow_not_found', 'Source or target status not found');
      }
      if (source.is_retired || target.is_retired) {
        throw new WorkflowDomainError('workflow_status_retired', 'Cannot create transition involving a retired status');
      }

      const existingEdge = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id
        FROM workflow_transitions
        WHERE team_id = ${command.teamId}::uuid
          AND source_status_id = ${command.sourceStatusId}::uuid
          AND target_status_id = ${command.targetStatusId}::uuid
      `;
      if (existingEdge.length > 0) {
        throw new WorkflowDomainError('workflow_invalid_transition', 'Transition edge already exists');
      }

      const inserted = await tx.$queryRaw<RawTransitionRow[]>`
        INSERT INTO workflow_transitions(workspace_id, team_id, source_status_id, target_status_id)
        VALUES (${command.workspaceId}::uuid, ${command.teamId}::uuid,
                ${command.sourceStatusId}::uuid, ${command.targetStatusId}::uuid)
        RETURNING id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
                  source_status_id::text AS source_status_id, target_status_id::text AS target_status_id,
                  created_at
      `;

      const nextVersion = team.workflow_version + 1;
      await tx.$executeRaw`
        UPDATE teams
        SET workflow_version = ${nextVersion}
        WHERE workspace_id = ${command.workspaceId}::uuid AND id = ${command.teamId}::uuid
      `;

      return {
        transition: mapTransitionRow(inserted[0]!),
        version: nextVersion,
      };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async deleteTransition(command: DeleteTransitionCommand): Promise<{ version: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorkspace(tx, command.workspaceId);
      const team = await this.lockTeam(tx, command.workspaceId, command.teamId);
      this.assertVersion(team.workflow_version, command.expectedVersion);

      const deleted = await tx.$executeRaw`
        DELETE FROM workflow_transitions
        WHERE workspace_id = ${command.workspaceId}::uuid
          AND team_id = ${command.teamId}::uuid
          AND source_status_id = ${command.sourceStatusId}::uuid
          AND target_status_id = ${command.targetStatusId}::uuid
      `;
      if (deleted === 0) {
        throw new WorkflowDomainError('workflow_not_found', 'Transition edge not found');
      }

      const nextVersion = team.workflow_version + 1;
      await tx.$executeRaw`
        UPDATE teams
        SET workflow_version = ${nextVersion}
        WHERE workspace_id = ${command.workspaceId}::uuid AND id = ${command.teamId}::uuid
      `;

      return { version: nextVersion };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  // WorkflowPort implementation
  async getDefaultStatus(scope: { workspaceId: string; teamId: string }): Promise<WorkflowStatusSummary> {
    const rows = await this.prisma.$queryRaw<RawStatusRow[]>`
      SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
             key, name, category, position, is_default, is_retired, created_at, updated_at
      FROM workflow_statuses
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND team_id = ${scope.teamId}::uuid
        AND is_default = true
        AND is_retired = false
      LIMIT 1
    `;
    if (rows[0]) return mapStatusRow(rows[0]);

    const fallback = await this.prisma.$queryRaw<RawStatusRow[]>`
      SELECT id::text AS id, workspace_id::text AS workspace_id, team_id::text AS team_id,
             key, name, category, position, is_default, is_retired, created_at, updated_at
      FROM workflow_statuses
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND team_id = ${scope.teamId}::uuid
        AND is_retired = false
      ORDER BY position ASC, id ASC
      LIMIT 1
    `;
    if (!fallback[0]) {
      throw new WorkflowDomainError('workflow_not_found', 'No active status found for team');
    }
    return mapStatusRow(fallback[0]);
  }

  async resolveStatus(scope: { workspaceId: string; teamId: string }, statusIdOrKey: string): Promise<WorkflowStatusSummary | null> {
    if (isUuid(statusIdOrKey)) {
      const byId = await this.getStatus(scope, statusIdOrKey);
      if (byId) return byId;
    }
    return this.getStatusByKey(scope, statusIdOrKey);
  }

  async canTransition(scope: { workspaceId: string; teamId: string }, sourceStatusId: string, targetStatusId: string): Promise<boolean> {
    if (!isUuid(sourceStatusId) || !isUuid(targetStatusId)) return false;
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM workflow_transitions
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND team_id = ${scope.teamId}::uuid
        AND source_status_id = ${sourceStatusId}::uuid
        AND target_status_id = ${targetStatusId}::uuid
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  private async lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new WorkflowDomainError('workflow_not_found', 'Workspace not found');
    }
  }

  private async lockTeam(tx: Prisma.TransactionClient, workspaceId: string, teamId: string): Promise<LockedTeam> {
    const rows = await tx.$queryRaw<LockedTeam[]>`
      SELECT id::text AS id, workflow_version
      FROM teams
      WHERE workspace_id = ${workspaceId}::uuid AND id = ${teamId}::uuid
      FOR UPDATE
    `;
    const team = rows[0];
    if (!team) {
      throw new WorkflowDomainError('workflow_not_found', 'Team not found');
    }
    return team;
  }

  private assertVersion(actualVersion: number, expectedVersion: number): void {
    if (actualVersion !== expectedVersion) {
      throw new WorkflowDomainError('workflow_version_conflict', `Workflow version conflict: expected ${expectedVersion}, current ${actualVersion}`);
    }
  }
}
