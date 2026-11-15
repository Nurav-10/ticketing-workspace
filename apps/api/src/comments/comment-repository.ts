import type { CommentMutationInput, CommentScope, NormalizedCreateComment } from './comment-domain.js';

export interface CommentActorScope extends CommentScope { actorUserId: string; }
export interface AuthorizedCommentMutation extends CommentActorScope, CommentMutationInput {}

export interface IssueComment {
  id: string;
  workspaceId: string;
  teamId: string;
  issueId: string;
  authorUserId: string;
  authorDisplayName: string;
  body: string | null;
  format: 'plain_text';
  version: number;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface CommentPage { items: IssueComment[]; nextCursor?: string; }
export interface AuthorizedCommentCreate extends CommentActorScope, NormalizedCreateComment {}

/** Every method applies workspace, team, issue, active membership, and private-team visibility predicates. */
export interface CommentRepository {
  listAuthorized(query: CommentActorScope & { limit: number; cursor?: string }): Promise<CommentPage>;
  createAuthorized(command: AuthorizedCommentCreate): Promise<IssueComment>;
  updateAuthorized(command: AuthorizedCommentMutation & { body: string }): Promise<IssueComment>;
  deleteAuthorized(command: AuthorizedCommentMutation): Promise<IssueComment>;
}
