import { isUuid } from '../issues/issue-domain.js';

export const ISSUE_SEARCH_TERM_MAX_LENGTH = 200;
export const ISSUE_SEARCH_DEFAULT_LIMIT = 25;
export const ISSUE_SEARCH_MAX_LIMIT = 100;
export const ISSUE_SEARCH_CURSOR_MAX_LENGTH = 1_024;

export type IssueSearchArchiveMode = 'active' | 'archived' | 'all';

export interface IssueSearchScope {
  workspaceId: string;
  teamId: string;
}

export interface IssueSearchInput extends IssueSearchScope {
  searchTerm: string;
  archiveMode?: IssueSearchArchiveMode;
  limit?: number;
  cursor?: string;
}

export interface NormalizedIssueSearchInput extends Omit<IssueSearchInput, 'archiveMode' | 'limit'> {
  archiveMode: IssueSearchArchiveMode;
  limit: number;
}

export type IssueSearchErrorCode = 'invalid_issue_search_input' | 'issue_search_not_found' | 'issue_search_cursor_stale';

export class IssueSearchDomainError extends Error {
  constructor(readonly code: IssueSearchErrorCode, message: string) {
    super(message);
    this.name = 'IssueSearchDomainError';
  }
}

function invalid(message: string): never {
  throw new IssueSearchDomainError('invalid_issue_search_input', message);
}

export function validateIssueSearchInput(value: unknown): NormalizedIssueSearchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Search input must be an object');
  const input = value as Record<string, unknown>;
  const allowed = ['workspaceId', 'teamId', 'searchTerm', 'archiveMode', 'limit', 'cursor'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid('Search input contains an unsupported field');
  if (!isUuid(input.workspaceId) || !isUuid(input.teamId)) return invalid('Workspace and team IDs must be UUIDs');
  if (typeof input.searchTerm !== 'string') return invalid('Search term is required');
  const searchTerm = input.searchTerm.trim();
  if (!searchTerm || searchTerm.includes('\0') || [...searchTerm].length > ISSUE_SEARCH_TERM_MAX_LENGTH) {
    return invalid(`Search term must contain 1 to ${ISSUE_SEARCH_TERM_MAX_LENGTH} characters`);
  }
  const archiveMode = input.archiveMode === undefined ? 'active' : input.archiveMode;
  if (archiveMode !== 'active' && archiveMode !== 'archived' && archiveMode !== 'all') return invalid('Archive mode is invalid');
  const limit = input.limit === undefined ? ISSUE_SEARCH_DEFAULT_LIMIT : input.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > ISSUE_SEARCH_MAX_LIMIT) {
    return invalid(`Search limit must be an integer from 1 to ${ISSUE_SEARCH_MAX_LIMIT}`);
  }
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor
    || input.cursor.length > ISSUE_SEARCH_CURSOR_MAX_LENGTH)) return invalid('Search cursor is invalid');
  return {
    workspaceId: input.workspaceId.toLowerCase(), teamId: input.teamId.toLowerCase(), searchTerm,
    archiveMode, limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
}
