export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
}

export interface WorkspaceRepository {
  listForUser(userId: string): Promise<WorkspaceSummary[]>;
}
