import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import { isUuid } from '../issues/issue-domain.js';
import { IssueLabelDomainError, type IssueLabelErrorCode, type IssueLabelApplicationService } from './issue-label-service.js';

const ASSIGNMENT_ROOT = '/workspaces/:workspaceId/teams/:teamId/issues/:issueId/labels';

function invalidRequest(): ApiError {
  return new ApiError(400, 'invalid_request', 'Request validation failed');
}

function requirePrincipal(request: Request) {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}

function requireUuid(value: unknown): string {
  if (!isUuid(value)) throw invalidRequest();
  return value;
}

function strictBody(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['labelIds', 'expectedVersion'].includes(key))) throw invalidRequest();
  if (!Object.hasOwn(value, 'labelIds') || !Array.isArray(value.labelIds)) throw invalidRequest();
  return value;
}

function expectedVersion(request: Request, body: Record<string, unknown>): number {
  const bodyVersion = body.expectedVersion;
  const ifMatch = request.get('If-Match');
  if (ifMatch !== undefined) {
    const match = /^"([1-9]\d*)"$/.exec(ifMatch);
    const version = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(version) || (bodyVersion !== undefined && bodyVersion !== version)) throw invalidRequest();
    return version;
  }
  if (typeof bodyVersion !== 'number' || !Number.isSafeInteger(bodyVersion) || bodyVersion < 1) throw invalidRequest();
  return bodyVersion;
}

export function mapIssueLabelError(error: IssueLabelDomainError): ApiError {
  const mapping: Record<IssueLabelErrorCode, readonly [number, string]> = {
    invalid_issue_label_input: [400, 'invalid_request'],
    issue_label_not_found: [404, 'not_found'],
    issue_label_forbidden: [403, 'forbidden'],
    issue_label_version_conflict: [409, 'version_conflict'],
  };
  const [status, code] = mapping[error.code];
  return new ApiError(status, code, error.message);
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof IssueLabelDomainError) throw mapIssueLabelError(error);
    throw error;
  }
}

/** Registers the scoped issue-label replacement endpoint. */
export function registerIssueLabelRoutes(router: Router, service: IssueLabelApplicationService): void {
  router.use(ASSIGNMENT_ROOT, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(ASSIGNMENT_ROOT, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    if (Object.keys(request.query).length) throw invalidRequest();
    const result = await invoke(() => service.getForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId), teamId: requireUuid(request.params.teamId), issueId: requireUuid(request.params.issueId),
    }));
    response.setHeader('ETag', `"${result.version}"`);
    response.json({ data: result });
  });

  router.put(ASSIGNMENT_ROOT, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const body = strictBody(request);
    const result = await invoke(() => service.replaceForPrincipal(principal, {
      workspaceId: requireUuid(request.params.workspaceId),
      teamId: requireUuid(request.params.teamId),
      issueId: requireUuid(request.params.issueId),
      expectedVersion: expectedVersion(request, body),
      labelIds: body.labelIds as string[],
    }));
    response.setHeader('ETag', `"${result.version}"`);
    response.json({ data: result });
  });
}
