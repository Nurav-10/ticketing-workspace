import type { QueryResultRow } from 'pg';

export interface WorkspaceSummary extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
}

export interface WorkspaceRepository {
  listForUser(userId: string): Promise<WorkspaceSummary[]>;
}
