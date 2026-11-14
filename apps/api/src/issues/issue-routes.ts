import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import { IssueDomainError, isIssuePriority, isIssueStatus, type IssueErrorCode, type IssuePriority } from './issue-domain.js';
import type { IssueService } from './issue-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_ROOT = '/workspaces/:workspaceId/teams/:teamId/issues';

function requirePrincipal(request: Request) {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidRequest();
  return value;
}

function invalidRequest(): ApiError {
  return new ApiError(400, 'invalid_request', 'Request validation failed');
}

function strictBody(request: Request, allowedFields: readonly string[], requiredFields: readonly string[] = []): Record<string, unknown> {
  const value: unknown = request.body === undefined ? {} : request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowedFields.includes(key)) || requiredFields.some((key) => !Object.hasOwn(body, key))) {
    throw invalidRequest();
  }
  return body;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function singleQuery(request: Request, name: string): string | undefined {
  const value = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidRequest();
  return value;
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

function setIssueEtag(response: Response, version: number): void {
  response.setHeader('ETag', `"${version}"`);
}

function mapIssueError(error: IssueDomainError): ApiError {
  const statuses: Record<IssueErrorCode, number> = {
    invalid_issue_input: 400,
    issue_not_found: 404,
    issue_forbidden: 403,
    issue_version_conflict: 409,
    issue_invalid_transition: 409,
    issue_number_exhausted: 409,
    issue_idempotency_conflict: 409,
    issue_assignee_unavailable: 400,
  };
  const codes: Record<IssueErrorCode, string> = {
    invalid_issue_input: 'invalid_request',
    issue_not_found: 'not_found',
    issue_forbidden: 'forbidden',
    issue_version_conflict: 'version_conflict',
    issue_invalid_transition: 'invalid_transition',
    issue_number_exhausted: 'number_exhausted',
    issue_idempotency_conflict: 'idempotency_conflict',
    issue_assignee_unavailable: 'invalid_assignee',
  };
  return new ApiError(statuses[error.code], codes[error.code], error.message);
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof IssueDomainError) throw mapIssueError(error);
    throw error;
  }
}

export function registerIssueRoutes(router: Router, service: IssueService): void {
  router.use(ISSUE_ROOT, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.post(ISSUE_ROOT, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const body = strictBody(request, ['title', 'description', 'priority', 'assigneeUserId'], ['title']);
    if (typeof body.title !== 'string' || (body.description !== undefined && body.description !== null && typeof body.description !== 'string') ||
      (body.priority !== undefined && !isIssuePriority(body.priority)) ||
      (body.assigneeUserId !== undefined && body.assigneeUserId !== null && typeof body.assigneeUserId !== 'string')) throw invalidRequest();
    const idempotencyKey = request.get('Idempotency-Key');
    if (idempotencyKey === undefined) throw invalidRequest();
    const issue = await invoke(() => service.createForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId),
      title: body.title as string, ...(body.description !== undefined ? { description: body.description as string | null } : {}),
      ...(body.priority !== undefined ? { priority: body.priority as IssuePriority } : {}),
      ...(body.assigneeUserId !== undefined ? { assigneeUserId: body.assigneeUserId as string | null } : {}), idempotencyKey,
    }));
    response.setHeader('Cache-Control', 'no-store');
    setIssueEtag(response, issue.version);
    response.status(201).json({ data: issue });
  });

  router.get(ISSUE_ROOT, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const allowed = new Set(['limit', 'cursor', 'status', 'priority', 'assigneeUserId', 'archived']);
    if (Object.keys(request.query).some((key) => !allowed.has(key))) throw invalidRequest();
    const limitText = singleQuery(request, 'limit');
    const limit = limitText === undefined ? undefined : parsePositiveInteger(limitText);
    if (limitText !== undefined && limit === undefined) throw invalidRequest();
    const status = singleQuery(request, 'status');
    const priority = singleQuery(request, 'priority');
    const assigneeUserId = singleQuery(request, 'assigneeUserId');
    const cursor = singleQuery(request, 'cursor');
    const archived = singleQuery(request, 'archived');
    if (archived !== undefined && archived !== 'true' && archived !== 'false') throw invalidRequest();
    if ((status !== undefined && !isIssueStatus(status)) || (priority !== undefined && !isIssuePriority(priority))) throw invalidRequest();
    const page = await invoke(() => service.listForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId),
      ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}),
      ...(status !== undefined ? { status } : {}), ...(priority !== undefined ? { priority } : {}), ...(assigneeUserId !== undefined ? { assigneeUserId } : {}),
      ...(archived !== undefined ? { archived: archived === 'true' } : {}),
    }));
    response.json({ data: page });
  });

  router.get(`${ISSUE_ROOT}/:issueId`, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const allowed = new Set(['activityLimit', 'activityCursor']);
    if (Object.keys(request.query).some((key) => !allowed.has(key))) throw invalidRequest();
    const limitText = singleQuery(request, 'activityLimit');
    const activityLimit = limitText === undefined ? undefined : parsePositiveInteger(limitText);
    if (limitText !== undefined && activityLimit === undefined) throw invalidRequest();
    const activityCursor = singleQuery(request, 'activityCursor');
    const detail = await invoke(() => service.getForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId),
      ...(activityLimit !== undefined ? { activityLimit } : {}), ...(activityCursor !== undefined ? { activityCursor } : {}),
    }));
    response.setHeader('Cache-Control', 'no-store');
    setIssueEtag(response, detail.issue.version);
    response.json({ data: detail });
  });

  router.patch(`${ISSUE_ROOT}/:issueId`, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const body = strictBody(request, ['expectedVersion', 'title', 'description', 'priority', 'assigneeUserId']);
    if (!['title', 'description', 'priority', 'assigneeUserId'].some((field) => Object.hasOwn(body, field)) ||
      (body.title !== undefined && typeof body.title !== 'string') ||
      (body.description !== undefined && body.description !== null && typeof body.description !== 'string') ||
      (body.priority !== undefined && !isIssuePriority(body.priority)) ||
      (body.assigneeUserId !== undefined && body.assigneeUserId !== null && typeof body.assigneeUserId !== 'string')) throw invalidRequest();
    const issue = await invoke(() => service.updateForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId), expectedVersion: expectedVersion(request, body),
      ...(Object.hasOwn(body, 'title') ? { title: body.title as string } : {}), ...(Object.hasOwn(body, 'description') ? { description: body.description as string | null } : {}),
      ...(Object.hasOwn(body, 'priority') ? { priority: body.priority as IssuePriority } : {}), ...(Object.hasOwn(body, 'assigneeUserId') ? { assigneeUserId: body.assigneeUserId as string | null } : {}),
    }));
    setIssueEtag(response, issue.version);
    response.json({ data: issue });
  });

  router.post(`${ISSUE_ROOT}/:issueId/transitions`, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const body = strictBody(request, ['expectedVersion', 'targetStatus'], ['targetStatus']);
    if (!isIssueStatus(body.targetStatus)) throw invalidRequest();
    const targetStatus = body.targetStatus;
    const issue = await invoke(() => service.transitionForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId),
      expectedVersion: expectedVersion(request, body), targetStatus,
    }));
    setIssueEtag(response, issue.version);
    response.json({ data: issue });
  });

  for (const [action, method] of [['archive', 'archiveForPrincipal'], ['restore', 'restoreForPrincipal']] as const) {
    router.post(`${ISSUE_ROOT}/:issueId/${action}`, async (request: Request, response: Response) => {
      const principal = requirePrincipal(request);
      const body = strictBody(request, ['expectedVersion']);
      const issue = await invoke(() => service[method](principal, {
        workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId), expectedVersion: expectedVersion(request, body),
      }));
      setIssueEtag(response, issue.version);
      response.json({ data: issue });
    });
  }
}

export { mapIssueError };
