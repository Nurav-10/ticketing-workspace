import type { Principal } from '../auth/authenticator.js';
import { isUuid, type IssueSummary } from '../issues/issue-domain.js';
import { IssueSearchDomainError, validateIssueSearchInput, type IssueSearchInput, type NormalizedIssueSearchInput } from './issue-search-domain.js';

export interface AuthorizedIssueSearch extends NormalizedIssueSearchInput {
  actorUserId: string;
}

export interface IssueSearchPage {
  items: IssueSearchItem[];
  nextCursor?: string;
}

// Search results omit description and the separately authorized assignee profile.
export type IssueSearchItem = Omit<IssueSummary, 'description' | 'assignee' | 'workflowStatusId'>;

export interface IssueSearchRepository {
  searchAuthorized(query: AuthorizedIssueSearch): Promise<IssueSearchPage>;
}

function actorId(principal: Principal): string {
  if (!principal || !isUuid(principal.userId) || typeof principal.sessionId !== 'string' || !principal.sessionId) {
    throw new IssueSearchDomainError('issue_search_not_found', 'Search results are unavailable');
  }
  return principal.userId.toLowerCase();
}

/** Validates a plain-text query and derives the actor from the verified principal. */
export class IssueSearchApplicationService {
  constructor(private readonly repository: IssueSearchRepository) {}

  async searchForPrincipal(principal: Principal, input: IssueSearchInput): Promise<IssueSearchPage> {
    const normalized = validateIssueSearchInput(input);
    return this.repository.searchAuthorized({ ...normalized, actorUserId: actorId(principal) });
  }
}
