export interface ProjectInput {
  workspaceId: string; teamId: string; name: string; description?: string | null;
  status?: 'planned' | 'in_progress' | 'completed' | 'canceled'; startAt?: Date | null; targetAt?: Date | null; actorUserId: string;
}
export interface CycleInput {
  workspaceId: string; teamId: string; name: string; startAt: Date; endAt: Date; actorUserId: string;
}
export interface GroupIssueInput {
  workspaceId: string; teamId: string; issueId: string; projectId?: string | null; cycleId?: string | null; expectedVersion: number; actorUserId: string;
}
export interface PlanningRepository {
  listProjects(input: { workspaceId: string; teamId: string; actorUserId: string }): Promise<unknown[]>;
  createProject(input: ProjectInput): Promise<unknown>;
  listCycles(input: { workspaceId: string; teamId: string; actorUserId: string }): Promise<unknown[]>;
  createCycle(input: CycleInput): Promise<unknown>;
  groupIssue(input: GroupIssueInput): Promise<unknown>;
}
