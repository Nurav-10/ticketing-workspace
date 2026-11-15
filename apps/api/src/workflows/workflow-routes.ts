import type { Request, Response, Router } from 'express';
import { ApiError } from '../shared/api-error.js';
import {
  WorkflowDomainError,
  isWorkflowCategory,
  type WorkflowErrorCode,
} from './workflow-domain.js';
import type { WorkflowService } from './workflow-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKFLOW_ROOT = '/workspaces/:workspaceId/teams/:teamId/workflow';

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

function expectedVersion(request: Request, body?: Record<string, unknown>): number {
  const bodyVersion = body?.expectedVersion;
  const ifMatch = request.get('If-Match');
  if (ifMatch !== undefined) {
    const match = /^(?:W\/)?"([1-9]\d*)"$/.exec(ifMatch);
    const version = match ? parsePositiveInteger(match[1]) : undefined;
    if (version === undefined || (bodyVersion !== undefined && bodyVersion !== version)) throw invalidRequest();
    return version;
  }
  if (typeof bodyVersion !== 'number' || !Number.isSafeInteger(bodyVersion) || bodyVersion < 1) {
    const queryVersion = request.query.expectedVersion;
    if (typeof queryVersion === 'string') {
      const parsed = parsePositiveInteger(queryVersion);
      if (parsed !== undefined) return parsed;
    }
    throw invalidRequest();
  }
  return bodyVersion;
}

function setWorkflowEtag(response: Response, version: number): void {
  response.setHeader('ETag', `W/"${version}"`);
}

function mapWorkflowError(error: WorkflowDomainError): ApiError {
  const statuses: Record<WorkflowErrorCode, number> = {
    invalid_workflow_input: 400,
    workflow_not_found: 404,
    workflow_forbidden: 403,
    workflow_version_conflict: 409,
    workflow_key_exists: 409,
    workflow_position_conflict: 409,
    workflow_invalid_transition: 409,
    workflow_status_retired: 409,
    workflow_default_invariant_violated: 409,
    workflow_reassignment_target_invalid: 409,
  };
  const codes: Record<WorkflowErrorCode, string> = {
    invalid_workflow_input: 'invalid_request',
    workflow_not_found: 'not_found',
    workflow_forbidden: 'forbidden',
    workflow_version_conflict: 'version_conflict',
    workflow_key_exists: 'key_exists',
    workflow_position_conflict: 'position_conflict',
    workflow_invalid_transition: 'invalid_transition',
    workflow_status_retired: 'status_retired',
    workflow_default_invariant_violated: 'default_invariant_violated',
    workflow_reassignment_target_invalid: 'invalid_reassignment_target',
  };
  return new ApiError(statuses[error.code], codes[error.code], error.message);
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkflowDomainError) throw mapWorkflowError(error);
    throw error;
  }
}

export function registerWorkflowRoutes(router: Router, service: WorkflowService): void {
  // GET canonical workflow configuration
  router.get(WORKFLOW_ROOT, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);

    const config = await invoke(() => service.getWorkflowForPrincipal(principal, { workspaceId, teamId }));
    setWorkflowEtag(response, config.version);
    response.json({ data: config });
  });

  // GET workflow statuses
  router.get(`${WORKFLOW_ROOT}/statuses`, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);
    const includeRetired = request.query.includeRetired === 'true';

    const statuses = await invoke(() => service.listStatusesForPrincipal(principal, { workspaceId, teamId }, includeRetired));
    response.json({ data: statuses });
  });

  // GET single workflow status
  router.get(`${WORKFLOW_ROOT}/statuses/:statusId`, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);
    const statusId = requireUuid(request.params.statusId);

    const status = await invoke(() => service.getStatusForPrincipal(principal, { workspaceId, teamId }, statusId));
    response.json({ data: status });
  });

  // POST create workflow status
  router.post(`${WORKFLOW_ROOT}/statuses`, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);
    const body = strictBody(
      request,
      ['key', 'name', 'category', 'position', 'isDefault', 'expectedVersion'],
      ['key', 'name', 'category'],
    );
    const version = expectedVersion(request, body);

    if (!isWorkflowCategory(body.category)) throw invalidRequest();
    if (typeof body.key !== 'string' || typeof body.name !== 'string') throw invalidRequest();
    if (body.position !== undefined && (typeof body.position !== 'number' || !Number.isSafeInteger(body.position) || body.position < 0)) {
      throw invalidRequest();
    }
    if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') throw invalidRequest();

    const category = body.category;
    const result = await invoke(() => service.createStatusForPrincipal(principal, {
      workspaceId,
      teamId,
      key: body.key as string,
      name: body.name as string,
      category,
      ...(typeof body.position === 'number' ? { position: body.position } : {}),
      ...(typeof body.isDefault === 'boolean' ? { isDefault: body.isDefault } : {}),
      expectedVersion: version,
    }));

    setWorkflowEtag(response, result.version);
    response.status(201).json({ data: result });
  });

  // PATCH update workflow status
  router.patch(`${WORKFLOW_ROOT}/statuses/:statusId`, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);
    const statusId = requireUuid(request.params.statusId);
    const body = strictBody(request, ['name', 'category', 'position', 'isDefault', 'expectedVersion']);
    const version = expectedVersion(request, body);

    if (body.category !== undefined && !isWorkflowCategory(body.category)) throw invalidRequest();
    if (body.name !== undefined && typeof body.name !== 'string') throw invalidRequest();
    if (body.position !== undefined && (typeof body.position !== 'number' || !Number.isSafeInteger(body.position) || body.position < 0)) {
      throw invalidRequest();
    }
    if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') throw invalidRequest();

    const category = body.category ? (body.category as import('./workflow-domain.js').WorkflowStatusCategory) : undefined;
    const result = await invoke(() => service.updateStatusForPrincipal(principal, {
      workspaceId,
      teamId,
      statusId,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(typeof body.position === 'number' ? { position: body.position } : {}),
      ...(typeof body.isDefault === 'boolean' ? { isDefault: body.isDefault } : {}),
      expectedVersion: version,
    }));

    setWorkflowEtag(response, result.version);
    response.json({ data: result });
  });

  // POST retire workflow status with atomic reassignment
  router.post(`${WORKFLOW_ROOT}/statuses/:statusId/retire`, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);
    const statusId = requireUuid(request.params.statusId);
    const body = strictBody(request, ['targetStatusId', 'expectedVersion'], ['targetStatusId']);
    const version = expectedVersion(request, body);
    const targetStatusId = requireUuid(body.targetStatusId);

    const result = await invoke(() => service.retireStatusForPrincipal(principal, {
      workspaceId,
      teamId,
      statusId,
      targetStatusId,
      expectedVersion: version,
    }));

    setWorkflowEtag(response, result.version);
    response.json({ data: result });
  });

  // POST add transition edge
  router.post(`${WORKFLOW_ROOT}/transitions`, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);
    const body = strictBody(request, ['sourceStatusId', 'targetStatusId', 'expectedVersion'], ['sourceStatusId', 'targetStatusId']);
    const version = expectedVersion(request, body);
    const sourceStatusId = requireUuid(body.sourceStatusId);
    const targetStatusId = requireUuid(body.targetStatusId);

    const result = await invoke(() => service.addTransitionForPrincipal(principal, {
      workspaceId,
      teamId,
      sourceStatusId,
      targetStatusId,
      expectedVersion: version,
    }));

    setWorkflowEtag(response, result.version);
    response.status(201).json({ data: result });
  });

  // DELETE transition edge
  router.delete(`${WORKFLOW_ROOT}/transitions/:sourceStatusId/:targetStatusId`, async (request, response) => {
    const principal = requirePrincipal(request);
    const workspaceId = requireUuid(request.params.workspaceId);
    const teamId = requireUuid(request.params.teamId);
    const sourceStatusId = requireUuid(request.params.sourceStatusId);
    const targetStatusId = requireUuid(request.params.targetStatusId);
    const body: Record<string, unknown> = typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
    const version = expectedVersion(request, body);

    const result = await invoke(() => service.deleteTransitionForPrincipal(principal, {
      workspaceId,
      teamId,
      sourceStatusId,
      targetStatusId,
      expectedVersion: version,
    }));

    setWorkflowEtag(response, result.version);
    response.json({ data: result });
  });
}
