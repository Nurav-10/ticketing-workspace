export const COMMENT_BODY_MAX_LENGTH = 10_000;
export const COMMENT_CONTENT_FORMAT = 'plain_text' as const;

export interface CommentScope {
  workspaceId: string;
  teamId: string;
  issueId: string;
}

export interface CreateCommentInput extends CommentScope { body: string; }
export interface NormalizedCreateComment extends CommentScope { body: string; format: typeof COMMENT_CONTENT_FORMAT; }
export interface CommentMutationInput extends CommentScope { commentId: string; expectedVersion: number; }

export type CommentErrorCode = 'invalid_comment_input' | 'comment_not_found' | 'comment_forbidden' | 'comment_version_conflict';

export class CommentDomainError extends Error {
  constructor(readonly code: CommentErrorCode, message: string) {
    super(message);
    this.name = 'CommentDomainError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(message: string): never { throw new CommentDomainError('invalid_comment_input', message); }
function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(`${label} must be a UUID`);
  return value;
}

function validateScope(input: CommentScope): CommentScope {
  return {
    workspaceId: requireUuid(input?.workspaceId, 'Workspace ID'),
    teamId: requireUuid(input?.teamId, 'Team ID'),
    issueId: requireUuid(input?.issueId, 'Issue ID'),
  };
}

export function validateCommentInput(input: CreateCommentInput): NormalizedCreateComment {
  const scope = validateScope(input);
  if (typeof input.body !== 'string') invalid('Comment body must be text');
  const body = input.body.trim();
  if (!body || body.length > COMMENT_BODY_MAX_LENGTH) invalid('Comment body is empty or too long');
  return { ...scope, body, format: COMMENT_CONTENT_FORMAT };
}

export function validateCommentMutation(input: CommentMutationInput): CommentMutationInput {
  const scope = validateScope(input);
  const commentId = requireUuid(input?.commentId, 'Comment ID');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) invalid('Expected version must be a positive integer');
  return { ...scope, commentId, expectedVersion: input.expectedVersion };
}

export function validateCommentList(input: CommentScope & { limit?: number; cursor?: string }): CommentScope & { limit: number; cursor?: string } {
  const scope = validateScope(input);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Limit must be an integer from 1 to 100');
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 512)) invalid('Cursor is invalid');
  return { ...scope, limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) };
}
