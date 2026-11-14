import type pg from 'pg';
import type { WorkspaceRepository, WorkspaceSummary } from './workspace-repository.js';

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const { rows } = await this.pool.query<WorkspaceSummary>(
      `SELECT w.id, w.name, w.slug, m.role FROM workspace_memberships m
       JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.name`, [userId]
    );
    return rows;
  }
}
