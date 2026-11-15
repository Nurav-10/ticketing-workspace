import type { Principal } from '../auth/authenticator.js';
import { isUuid } from '../issues/issue-domain.js';
import {
  DEFAULT_LABEL_COLOR,
  DEFAULT_LABEL_PAGE_SIZE,
  LabelDomainError,
  decodeLabelCursor,
  encodeLabelCursor,
  normalizeLabelName,
  validateExpectedLabelVersion,
  validateLabelColor,
  validateLabelId,
  validateLabelName,
  validateLabelPageSize,
  validateLabelScope,
  type LabelPage,
  type LabelScope,
} from './label-domain.js';
import type { LabelRepository } from './label-repository.js';

export interface ListLabelsInput extends LabelScope { limit?: number; cursor?: string }
export interface CreateLabelInput extends LabelScope { name: string; color?: string }
export interface UpdateLabelInput extends LabelScope {
  labelId: string;
  expectedVersion: number;
  name?: string;
  color?: string;
}
export interface DeleteLabelInput extends LabelScope { labelId: string; expectedVersion: number }

function actorId(principal: Principal): string {
  if (!principal || !isUuid(principal.userId) || typeof principal.sessionId !== 'string' || principal.sessionId.length === 0) {
    throw new LabelDomainError('label_forbidden', 'A verified principal is required');
  }
  return principal.userId.toLowerCase();
}

function strictKeys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabelDomainError('invalid_label_input', 'Label input must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new LabelDomainError('invalid_label_input', 'Label input contains an unsupported field');
  }
}

/** Pure validation and principal-to-repository coordination; no route/runtime wiring. */
export class LabelApplicationService {
  constructor(private readonly repository: LabelRepository) {}

  async listForPrincipal(principal: Principal, input: ListLabelsInput): Promise<LabelPage> {
    strictKeys(input, ['workspaceId', 'teamId', 'limit', 'cursor']);
    const scope = validateLabelScope(input);
    const actorUserId = actorId(principal);
    const limit = input.limit === undefined ? DEFAULT_LABEL_PAGE_SIZE : validateLabelPageSize(input.limit);
    const afterId = input.cursor === undefined
      ? undefined
      : decodeLabelCursor(input.cursor, { ...scope, actorUserId }).afterId;
    const rows = await this.repository.listAuthorized({
      ...scope, actorUserId, limit,
      ...(afterId ? { afterId } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeLabelCursor({ ...scope, actorUserId }, last.id) : null,
    };
  }

  async createForPrincipal(principal: Principal, input: CreateLabelInput) {
    strictKeys(input, ['workspaceId', 'teamId', 'name', 'color']);
    const scope = validateLabelScope(input);
    const name = validateLabelName(input.name);
    const color = input.color === undefined ? DEFAULT_LABEL_COLOR : validateLabelColor(input.color);
    return this.repository.createAuthorized({
      ...scope,
      actorUserId: actorId(principal),
      name,
      normalizedName: normalizeLabelName(name),
      color,
    });
  }

  async updateForPrincipal(principal: Principal, input: UpdateLabelInput) {
    strictKeys(input, ['workspaceId', 'teamId', 'labelId', 'expectedVersion', 'name', 'color']);
    const changes: { name?: string; normalizedName?: string; color?: string } = {};
    if (Object.hasOwn(input, 'name')) {
      changes.name = validateLabelName(input.name);
      changes.normalizedName = normalizeLabelName(changes.name);
    }
    if (Object.hasOwn(input, 'color')) changes.color = validateLabelColor(input.color);
    if (Object.keys(changes).length === 0) throw new LabelDomainError('invalid_label_input', 'Update must change a name or color');
    return this.repository.updateAuthorized({
      ...validateLabelScope(input), actorUserId: actorId(principal), labelId: validateLabelId(input.labelId),
      expectedVersion: validateExpectedLabelVersion(input.expectedVersion), changes,
    });
  }

  async deleteForPrincipal(principal: Principal, input: DeleteLabelInput): Promise<void> {
    strictKeys(input, ['workspaceId', 'teamId', 'labelId', 'expectedVersion']);
    return this.repository.deleteAuthorized({
      ...validateLabelScope(input), actorUserId: actorId(principal), labelId: validateLabelId(input.labelId),
      expectedVersion: validateExpectedLabelVersion(input.expectedVersion),
    });
  }
}
