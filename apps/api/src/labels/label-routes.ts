import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import { LabelDomainError, MAX_LABEL_PAGE_SIZE, validateLabelId, validateLabelScope } from './label-domain.js';
import type { LabelApplicationService } from './label-service.js';

const LABEL_ROOT = '/workspaces/:workspaceId/teams/:teamId/labels';

function invalidRequest(): ApiError {
  return new ApiError(400, 'invalid_request', 'Request validation failed');
}

function requirePrincipal(request: Request) {
  if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return request.principal;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strictObject(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  const result = object(value);
  if (!result || Object.keys(result).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(result, key))) throw invalidRequest();
  return result;
}

function routeScope(request: Request) {
  try {
    return validateLabelScope({ workspaceId: request.params.workspaceId, teamId: request.params.teamId });
  } catch (error) {
    if (error instanceof LabelDomainError) throw invalidRequest();
    throw error;
  }
}

function routeLabelId(request: Request): string {
  try { return validateLabelId(request.params.labelId); }
  catch (error) {
    if (error instanceof LabelDomainError) throw invalidRequest();
    throw error;
  }
}

function listQuery(request: Request): { limit?: number; cursor?: string } {
  const query = request.query as Record<string, unknown>;
  const allowed = ['limit', 'cursor'];
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw invalidRequest();
  const result: { limit?: number; cursor?: string } = {};
  if (Object.hasOwn(query, 'limit')) {
    const raw = query.limit;
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) throw invalidRequest();
    const limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LABEL_PAGE_SIZE) throw invalidRequest();
    result.limit = limit;
  }
  if (Object.hasOwn(query, 'cursor')) {
    if (typeof query.cursor !== 'string' || query.cursor.length === 0) throw invalidRequest();
    result.cursor = query.cursor;
  }
  return result;
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

export function mapLabelError(error: LabelDomainError): ApiError {
  const mapping = {
    invalid_label_input: [400, 'invalid_request'],
    label_not_found: [404, 'not_found'],
    label_forbidden: [403, 'forbidden'],
    label_version_conflict: [409, 'version_conflict'],
    label_in_use: [409, 'label_in_use'],
    label_name_conflict: [409, 'label_name_conflict'],
  } as const;
  const [status, code] = mapping[error.code];
  return new ApiError(status, code, error.message);
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof LabelDomainError) throw mapLabelError(error);
    throw error;
  }
}

function setLabelEtag(response: Response, version: number): void {
  response.setHeader('ETag', `"${version}"`);
}

/** Registers label CRUD endpoints on the authenticated API router. */
export function registerLabelRoutes(router: Router, service: LabelApplicationService): void {
  router.use(LABEL_ROOT, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(LABEL_ROOT, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const page = await invoke(() => service.listForPrincipal(principal, { ...routeScope(request), ...listQuery(request) }));
    response.json({ data: page.items, nextCursor: page.nextCursor });
  });

  router.post(LABEL_ROOT, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const body = strictObject(request.body, ['name', 'color'], ['name']);
    if (typeof body.name !== 'string' || (body.color !== undefined && typeof body.color !== 'string')) throw invalidRequest();
    const label = await invoke(() => service.createForPrincipal(principal, {
      ...routeScope(request), name: body.name as string,
      ...(body.color !== undefined ? { color: body.color as string } : {}),
    }));
    setLabelEtag(response, label.version);
    response.status(201).json({ data: label });
  });

  router.patch(`${LABEL_ROOT}/:labelId`, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const body = strictObject(request.body, ['expectedVersion', 'name', 'color']);
    if ((body.name !== undefined && typeof body.name !== 'string')
      || (body.color !== undefined && typeof body.color !== 'string')) throw invalidRequest();
    const label = await invoke(() => service.updateForPrincipal(principal, {
      ...routeScope(request), labelId: routeLabelId(request), expectedVersion: expectedVersion(request, body),
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.color !== undefined ? { color: body.color as string } : {}),
    }));
    setLabelEtag(response, label.version);
    response.json({ data: label });
  });

  router.delete(`${LABEL_ROOT}/:labelId`, async (request: Request, response: Response) => {
    const principal = requirePrincipal(request);
    const body = strictObject(request.body === undefined ? {} : request.body, ['expectedVersion']);
    await invoke(() => service.deleteForPrincipal(principal, {
      ...routeScope(request), labelId: routeLabelId(request), expectedVersion: expectedVersion(request, body),
    }));
    response.status(204).end();
  });
}
