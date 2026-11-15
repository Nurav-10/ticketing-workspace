import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import type { PlanningService } from './planning-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT = '/workspaces/:workspaceId/teams/:teamId';
const invalid = () => new ApiError(400, 'invalid_request', 'Request validation failed');
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw invalid(); return value; }
function actor(request: Request) { if (!request.principal) throw new ApiError(401, 'unauthenticated', 'Authentication required'); return request.principal; }
function body(request: Request, allowed: string[], required: string[] = []): Record<string, unknown> {
  const value: unknown = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(object, key))) throw invalid();
  return object;
}
function text(value: unknown, max: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max) throw invalid();
  return value.trim();
}
function nullableText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return text(value, max);
}
function date(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw invalid();
  const parsed = new Date(value); if (!Number.isFinite(parsed.valueOf())) throw invalid(); return parsed;
}
function nullableUuid(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return uuid(value);
}
function expectedVersion(request: Request, object: Record<string, unknown>): number {
  const header = request.get('If-Match');
  const headerValue = header === undefined ? undefined : /^"([1-9]\d*)"$/.exec(header)?.[1];
  const version = headerValue === undefined ? object.expectedVersion : Number(headerValue);
  if (!Number.isSafeInteger(version) || Number(version) < 1 || (object.expectedVersion !== undefined && object.expectedVersion !== Number(version))) throw invalid();
  return Number(version);
}
function reply(response: Response, data: unknown, status = 200) { response.setHeader('cache-control', 'no-store'); response.status(status).json({ data }); }

export function registerPlanningRoutes(router: Router, service: PlanningService): void {
  router.get(`${ROOT}/projects`, async (request, response) => {
    reply(response, await service.listProjects(actor(request), { workspaceId: uuid(request.params.workspaceId), teamId: uuid(request.params.teamId) }));
  });
  router.post(`${ROOT}/projects`, async (request, response) => {
    const value = body(request, ['name', 'description', 'status', 'startAt', 'targetAt'], ['name']);
    const status = value.status;
    if (status !== undefined && !['planned', 'in_progress', 'completed', 'canceled'].includes(String(status))) throw invalid();
    const description = nullableText(value.description, 5000);
    const result = await service.createProject(actor(request), {
      workspaceId: uuid(request.params.workspaceId), teamId: uuid(request.params.teamId), name: text(value.name, 120)!,
      ...(description !== undefined ? { description } : {}),
      ...(status !== undefined ? { status: status as 'planned' | 'in_progress' | 'completed' | 'canceled' } : {}),
      ...(value.startAt !== undefined ? { startAt: value.startAt === null ? null : date(value.startAt) } : {}),
      ...(value.targetAt !== undefined ? { targetAt: value.targetAt === null ? null : date(value.targetAt) } : {})
    });
    reply(response, result, 201);
  });
  router.get(`${ROOT}/cycles`, async (request, response) => {
    reply(response, await service.listCycles(actor(request), { workspaceId: uuid(request.params.workspaceId), teamId: uuid(request.params.teamId) }));
  });
  router.post(`${ROOT}/cycles`, async (request, response) => {
    const value = body(request, ['name', 'startAt', 'endAt'], ['name', 'startAt', 'endAt']);
    reply(response, await service.createCycle(actor(request), {
      workspaceId: uuid(request.params.workspaceId), teamId: uuid(request.params.teamId), name: text(value.name, 120)!,
      startAt: date(value.startAt), endAt: date(value.endAt)
    }), 201);
  });
  router.patch(`${ROOT}/issues/:issueId/grouping`, async (request, response) => {
    const value = body(request, ['projectId', 'cycleId', 'expectedVersion']);
    if (value.expectedVersion !== undefined && (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1)) throw invalid();
    const projectId = nullableUuid(value.projectId);
    const cycleId = nullableUuid(value.cycleId);
    const result = await service.groupIssue(actor(request), {
      workspaceId: uuid(request.params.workspaceId), teamId: uuid(request.params.teamId), issueId: uuid(request.params.issueId),
      ...(projectId !== undefined ? { projectId } : {}), ...(cycleId !== undefined ? { cycleId } : {}),
      expectedVersion: expectedVersion(request, value)
    }) as { version?: number };
    if (result.version) response.setHeader('ETag', `"${result.version}"`);
    reply(response, result);
  });
}
