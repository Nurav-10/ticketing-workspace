import type { Principal } from '../auth/authenticator.js';
import {
  CommentDomainError,
  validateCommentInput,
  validateCommentList,
  validateCommentMutation,
  type CommentScope,
  type CreateCommentInput,
} from './comment-domain.js';
import type { CommentPage, CommentRepository, IssueComment } from './comment-repository.js';

export interface CommentService {
  listForPrincipal(principal: Principal, query: CommentScope & { limit?: number; cursor?: string }): Promise<CommentPage>;
  createForPrincipal(principal: Principal, input: CreateCommentInput): Promise<IssueComment>;
  updateForPrincipal(principal: Principal, input: CommentScope & { commentId: string; expectedVersion: number; body: string }): Promise<IssueComment>;
  deleteForPrincipal(principal: Principal, input: CommentScope & { commentId: string; expectedVersion: number }): Promise<IssueComment>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function actorId(principal: Principal): string {
  if (!principal || !UUID_PATTERN.test(principal.userId)) throw new CommentDomainError('comment_forbidden', 'A verified principal is required');
  return principal.userId;
}

export class CommentApplicationService implements CommentService {
  constructor(private readonly repository: CommentRepository) {}

  listForPrincipal(principal: Principal, query: CommentScope & { limit?: number; cursor?: string }): Promise<CommentPage> {
    return this.repository.listAuthorized({ ...validateCommentList(query), actorUserId: actorId(principal) });
  }

  createForPrincipal(principal: Principal, input: CreateCommentInput): Promise<IssueComment> {
    return this.repository.createAuthorized({ ...validateCommentInput(input), actorUserId: actorId(principal) });
  }

  updateForPrincipal(principal: Principal, input: CommentScope & { commentId: string; expectedVersion: number; body: string }): Promise<IssueComment> {
    const actorUserId = actorId(principal);
    const { body, ...mutation } = input;
    const normalizedBody = validateCommentInput({ ...mutation, body }).body;
    return this.repository.updateAuthorized({ ...validateCommentMutation(mutation), actorUserId, body: normalizedBody });
  }

  deleteForPrincipal(principal: Principal, input: CommentScope & { commentId: string; expectedVersion: number }): Promise<IssueComment> {
    return this.repository.deleteAuthorized({ ...validateCommentMutation(input), actorUserId: actorId(principal) });
  }
}
