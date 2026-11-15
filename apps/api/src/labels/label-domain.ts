import { isUuid } from '../issues/issue-domain.js';

export const LABEL_NAME_MAX_LENGTH = 50;
export const DEFAULT_LABEL_COLOR = '#6b7280';
export const DEFAULT_LABEL_PAGE_SIZE = 50;
export const MAX_LABEL_PAGE_SIZE = 100;

export interface LabelScope {
  workspaceId: string;
  teamId: string;
}

export interface Label extends LabelScope {
  id: string;
  name: string;
  normalizedName: string;
  color: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LabelPage {
  items: Label[];
  nextCursor: string | null;
}

export interface LabelCursorScope extends LabelScope {
  actorUserId: string;
}

export interface DecodedLabelCursor extends LabelCursorScope {
  afterId: string;
}

export type LabelErrorCode = 'invalid_label_input' | 'label_not_found' | 'label_forbidden' | 'label_version_conflict' | 'label_in_use' | 'label_name_conflict';

export class LabelDomainError extends Error {
  constructor(readonly code: LabelErrorCode, message: string) {
    super(message);
    this.name = 'LabelDomainError';
  }
}

const LABEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const LABEL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function invalid(message: string): never {
  throw new LabelDomainError('invalid_label_input', message);
}

export function validateLabelScope(value: unknown): LabelScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Workspace and team scope are required');
  const scope = value as Record<string, unknown>;
  if (!isUuid(scope.workspaceId) || !isUuid(scope.teamId)) return invalid('Workspace and team IDs must be UUIDs');
  return { workspaceId: scope.workspaceId.toLowerCase(), teamId: scope.teamId.toLowerCase() };
}

/** Label names are trimmed ASCII words with spaces, hyphens or underscores. */
export function validateLabelName(value: unknown): string {
  if (typeof value !== 'string') return invalid('Label name is required');
  const name = value.trim();
  if (name.length < 1 || name.length > LABEL_NAME_MAX_LENGTH || !LABEL_NAME_PATTERN.test(name)) {
    return invalid(`Label name must be 1 to ${LABEL_NAME_MAX_LENGTH} characters using letters, numbers, spaces, hyphens or underscores`);
  }
  return name;
}

/** Stored separately to make team-local case-insensitive uniqueness explicit. */
export function normalizeLabelName(value: unknown): string {
  return validateLabelName(value).toLowerCase();
}

/** Canonical persisted color is lower-case six-digit hex. */
export function validateLabelColor(value: unknown): string {
  if (typeof value !== 'string' || !LABEL_COLOR_PATTERN.test(value)) return invalid('Label color must be a six-digit hexadecimal color');
  return value.toLowerCase();
}

export function validateLabelId(value: unknown): string {
  if (!isUuid(value)) return invalid('Label ID must be a UUID');
  return value.toLowerCase();
}

export function validateExpectedLabelVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid('Expected label version must be a positive integer');
  return value as number;
}

export function validateLabelPageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LABEL_PAGE_SIZE) {
    return invalid(`Label page size must be an integer from 1 to ${MAX_LABEL_PAGE_SIZE}`);
  }
  return value as number;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Encodes the complete authorization scope so a cursor cannot be replayed for another actor/team. */
export function encodeLabelCursor(scope: LabelCursorScope, afterId: string): string {
  const payload = {
    v: 1,
    workspaceId: scope.workspaceId,
    teamId: scope.teamId,
    actorUserId: scope.actorUserId,
    afterId,
  };
  return encodeBase64Url(JSON.stringify(payload));
}

/** Rejects malformed and cross-scope cursors before they reach persistence. */
export function decodeLabelCursor(value: unknown, expected: LabelCursorScope): DecodedLabelCursor {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid('Label cursor is malformed');
  let decoded: unknown;
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    if (encodeBase64Url(json) !== value) return invalid('Label cursor is malformed');
    decoded = JSON.parse(json);
  } catch {
    return invalid('Label cursor is malformed');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return invalid('Label cursor is malformed');
  const payload = decoded as Record<string, unknown>;
  if (Object.keys(payload).length !== 5 || payload.v !== 1
    || !isUuid(payload.workspaceId) || !isUuid(payload.teamId)
    || !isUuid(payload.actorUserId) || !isUuid(payload.afterId)) return invalid('Label cursor is malformed');
  const cursor = {
    workspaceId: (payload.workspaceId as string).toLowerCase(),
    teamId: (payload.teamId as string).toLowerCase(),
    actorUserId: (payload.actorUserId as string).toLowerCase(),
    afterId: (payload.afterId as string).toLowerCase(),
  };
  if (cursor.workspaceId !== expected.workspaceId || cursor.teamId !== expected.teamId
    || cursor.actorUserId !== expected.actorUserId) return invalid('Label cursor does not match this scope');
  return cursor;
}
