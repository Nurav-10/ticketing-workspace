import type { Label, LabelScope } from './label-domain.js';

/** The actor value is derived by the service from the verified session principal. */
export interface LabelActorScope extends LabelScope {
  actorUserId: string;
}

export interface CreateLabelCommand extends LabelActorScope {
  name: string;
  normalizedName: string;
  color: string;
}

export interface UpdateLabelCommand extends LabelActorScope {
  labelId: string;
  expectedVersion: number;
  changes: { name?: string; normalizedName?: string; color?: string };
}

export interface DeleteLabelCommand extends LabelActorScope {
  labelId: string;
  expectedVersion: number;
}

export interface ListLabelsQuery extends LabelActorScope {
  limit: number;
  /** Exclusive ID boundary; implementations fetch at most limit + 1 rows. */
  afterId?: string;
}

/**
 * Authorization-enforcing persistence boundary. Every query must scope by the
 * requested workspace and team before resolving a label. It must recheck active
 * workspace membership and team visibility/private-team membership from current
 * database facts; callers cannot supply these facts or a different actor ID.
 * Mutations must enforce the configured label-management policy (initially an
 * active workspace owner/admin with access to the team), compare expectedVersion
 * atomically for update/delete, and never cascade across a team's label scope.
 */
export interface LabelRepository {
  listAuthorized(query: ListLabelsQuery): Promise<Label[]>;
  createAuthorized(command: CreateLabelCommand): Promise<Label>;
  updateAuthorized(command: UpdateLabelCommand): Promise<Label>;
  deleteAuthorized(command: DeleteLabelCommand): Promise<void>;
}
