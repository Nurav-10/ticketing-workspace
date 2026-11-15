import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import { CommentDomainError, type CommentErrorCode } from './comment-domain.js';
import type { CommentService } from './comment-service.js';

const ISSUE_ROOT = '/workspaces/:workspaceId/teams/:teamId/issues/:issueId/comments';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidRequest(): ApiError { return new ApiError(400, 'invalid_request', 'Request validation failed'); }
function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidRequest();
  return value;
}
function requirePrincipal(request: Request) {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}
function strictBody(request: Request, allowedFields: readonly string[], requiredFields: readonly string[] = []): Record<string, unknown> {
  const value: unknown = request.body === undefined ? {} : request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowedFields.includes(key)) || requiredFields.some((key) => !Object.hasOwn(body, key))) throw invalidRequest();
  return body;
}
function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function expectedVersion(request: Request, body: Record<string, unknown>): number {
  const bodyVersion = body.expectedVersion;
  const ifMatch = request.get('If-Match');
  if (ifMatch !== undefined) {
    const match = /^"([1-9]\d*)"$/.exec(ifMatch);
    const version = match ? parsePositiveInteger(match[1]) : undefined;
    if (version === undefined || (bodyVersion !== undefined && bodyVersion !== version)) throw invalidRequest();
    return version;
  }
  if (typeof bodyVersion !== 'number' || !Number.isSafeInteger(bodyVersion) || bodyVersion < 1) throw invalidRequest();
  return bodyVersion;
}
function setEtag(response: Response, version: number): void { response.setHeader('ETag', `"${version}"`); }

function mapError(error: CommentDomainError): ApiError {
  const statuses: Record<CommentErrorCode, number> = {
    invalid_comment_input: 400,
    comment_not_found: 404,
    comment_forbidden: 403,
    comment_version_conflict: 409,
  };
  const codes: Record<CommentErrorCode, string> = {
    invalid_comment_input: 'invalid_request',
    comment_not_found: 'not_found',
    comment_forbidden: 'forbidden',
    comment_version_conflict: 'version_conflict',
  };
  return new ApiError(statuses[error.code], codes[error.code], error.message);
}
async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof CommentDomainError) throw mapError(error); throw error; }
}

export function registerCommentRoutes(router: Router, service: CommentService): void {
  router.use(ISSUE_ROOT, (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });

  router.get(ISSUE_ROOT, async (request, response) => {
    const principal = requirePrincipal(request);
    if (Object.keys(request.query).some((key) => !['limit', 'cursor'].includes(key))) throw invalidRequest();
    const limitText = request.query.limit;
    if (limitText !== undefined && typeof limitText !== 'string') throw invalidRequest();
    const limit = limitText === undefined ? undefined : parsePositiveInteger(limitText);
    if (limitText !== undefined && limit === undefined) throw invalidRequest();
    const cursor = request.query.cursor;
    if (cursor !== undefined && typeof cursor !== 'string') throw invalidRequest();
    const page = await invoke(() => service.listForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId),
      ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}),
    }));
    response.json({ data: page });
  });

  router.post(ISSUE_ROOT, async (request, response) => {
    const principal = requirePrincipal(request);
    const body = strictBody(request, ['body'], ['body']);
    if (typeof body.body !== 'string') throw invalidRequest();
    const commentBody = body.body;
    const comment = await invoke(() => service.createForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId), body: commentBody,
    }));
    setEtag(response, comment.version);
    response.status(201).json({ data: comment });
  });

  router.patch(`${ISSUE_ROOT}/:commentId`, async (request, response) => {
    const principal = requirePrincipal(request);
    const body = strictBody(request, ['body', 'expectedVersion'], ['body']);
    if (typeof body.body !== 'string') throw invalidRequest();
    const commentBody = body.body;
    const comment = await invoke(() => service.updateForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId),
      commentId: requireUuid(request.params.commentId), expectedVersion: expectedVersion(request, body), body: commentBody,
    }));
    setEtag(response, comment.version);
    response.json({ data: comment });
  });

  router.delete(`${ISSUE_ROOT}/:commentId`, async (request, response) => {
    const principal = requirePrincipal(request);
    const body = strictBody(request, ['expectedVersion']);
    const comment = await invoke(() => service.deleteForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId),
      commentId: requireUuid(request.params.commentId), expectedVersion: expectedVersion(request, body),
    }));
    setEtag(response, comment.version);
    response.json({ data: comment });
  });
}
