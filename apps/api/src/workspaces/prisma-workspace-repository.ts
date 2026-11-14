import type { PrismaClient } from '../generated/prisma/client.js';
import type { WorkspaceRepository, WorkspaceSummary } from './workspace-repository.js';

export class PrismaWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { userId },
      orderBy: { workspace: { name: 'asc' } },
      select: {
        role: true,
        workspace: { select: { id: true, name: true, slug: true } }
      }
    });
    return memberships.map(({ role, workspace }) => ({ ...workspace, role: role as WorkspaceSummary['role'] }));
  }
}
