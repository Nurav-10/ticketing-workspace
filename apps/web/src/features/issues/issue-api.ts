export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'canceled'
export type IssuePriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export type Issue = {
  id: string; workspaceId: string; teamId: string; issueNumber: number; key: string; title: string
  description: string | null; status: IssueStatus; priority: IssuePriority; assigneeUserId: string | null
  createdByUserId: string; version: number; createdAt: string; updatedAt: string; archivedAt: string | null
  assignee?: { id: string; displayName: string } | null
}
export type IssueDetail = { issue: Issue; activity: Array<{ id: string; kind: string; metadata: Record<string, unknown>; createdAt: string; actor?: { id: string; displayName: string } | null }>; nextActivityCursor?: string }
export type IssuePage = { items: Issue[]; nextCursor?: string }
export type IssueSearchItem = Pick<Issue, 'id' | 'key' | 'title' | 'status' | 'priority' | 'archivedAt'>
export type IssueSearchPage = { items: IssueSearchItem[]; nextCursor?: string }
export async function searchIssues(workspaceId: string, teamId: string, searchTerm: string, archiveMode: 'active' | 'archived', signal?: AbortSignal, cursor?: string): Promise<IssueSearchPage> {
  const { data } = await request<unknown>(`${root(workspaceId, teamId)}/search`, {
    method: 'POST', cache: 'no-store', signal, body: JSON.stringify({ searchTerm, archiveMode, ...(cursor ? { cursor } : {}) }),
  })
  const invalid = (): never => { throw new IssueApiError('The issue service returned an invalid response.', 200) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid()
  const page = data as Record<string, unknown>
  if (!Array.isArray(page.items) || (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 1024))) return invalid()
  const items = page.items.map((value: unknown): IssueSearchItem => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id || typeof item.key !== 'string' || typeof item.title !== 'string'
      || typeof item.status !== 'string' || !['backlog', 'todo', 'in_progress', 'done', 'canceled'].includes(item.status)
      || typeof item.priority !== 'string' || !['none', 'low', 'medium', 'high', 'urgent'].includes(item.priority)
      || (item.archivedAt !== null && typeof item.archivedAt !== 'string')) return invalid()
    return { id: item.id, key: item.key, title: item.title, status: item.status as IssueStatus, priority: item.priority as IssuePriority, archivedAt: item.archivedAt as string | null }
  })
  return { items, ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}) }
}
type Envelope<T> = { data: T }
type ApiErrorBody = { error?: { code?: string; message?: string; requestId?: string } }

export class IssueApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'IssueApiError' }
  get isVersionConflict() { return this.status === 409 && this.code === 'version_conflict' }
}
const root = (workspaceId: string, teamId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}/issues`
async function request<T>(path: string, init: RequestInit = {}): Promise<{ data: T; etag: string | null }> {
  let response: Response
  try { response = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }) }
  catch { throw new IssueApiError('Could not reach the issue service. Check your connection and retry.', 0) }
  if (!response.ok) {
    let body: ApiErrorBody = {}
    try { body = await response.json() as ApiErrorBody } catch { /* keep safe generic message */ }
    const code = body.error?.code
    const message = code === 'version_conflict' ? 'A newer version of this issue exists.' : body.error?.message || `Issue request failed (${response.status}).`
    throw new IssueApiError(message, response.status, code)
  }
  try { const envelope = await response.json() as Envelope<T>; if (!envelope || !('data' in envelope)) throw new Error(); return { data: envelope.data, etag: response.headers.get('ETag') } }
  catch { throw new IssueApiError('The issue service returned an invalid response.', response.status) }
}
export async function listIssues(workspaceId: string, teamId: string, signal?: AbortSignal, cursor?: string, archived = false): Promise<IssuePage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (archived) params.set('archived', 'true')
  const queryString = params.toString()
  const query = queryString ? `?${queryString}` : ''
  return (await request<IssuePage>(`${root(workspaceId, teamId)}${query}`, { signal })).data
}
export async function getIssue(workspaceId: string, teamId: string, id: string, signal?: AbortSignal, activityCursor?: string): Promise<IssueDetail> {
  const query = activityCursor ? `?${new URLSearchParams({ activityCursor }).toString()}` : ''
  return (await request<IssueDetail>(`${root(workspaceId, teamId)}/${encodeURIComponent(id)}${query}`, { signal })).data
}
export async function createIssue(workspaceId: string, teamId: string, input: { title: string; description: string | null; priority: IssuePriority; assigneeUserId: string | null }, idempotencyKey: string): Promise<Issue> {
  return (await request<Issue>(root(workspaceId, teamId), { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input) })).data
}
export async function updateIssue(workspaceId: string, teamId: string, issue: Issue, patch: Partial<Pick<Issue, 'title' | 'description' | 'priority' | 'assigneeUserId'>>): Promise<Issue> {
  return (await request<Issue>(`${root(workspaceId, teamId)}/${encodeURIComponent(issue.id)}`, { method: 'PATCH', headers: { 'If-Match': `"${issue.version}"` }, body: JSON.stringify(patch) })).data
}
export async function transitionIssue(workspaceId: string, teamId: string, issue: Issue, targetStatus: IssueStatus): Promise<Issue> {
  return (await request<Issue>(`${root(workspaceId, teamId)}/${encodeURIComponent(issue.id)}/transitions`, { method: 'POST', headers: { 'If-Match': `"${issue.version}"` }, body: JSON.stringify({ targetStatus }) })).data
}
export async function setIssueArchived(workspaceId: string, teamId: string, issue: Issue, archived: boolean): Promise<Issue> {
  return (await request<Issue>(`${root(workspaceId, teamId)}/${encodeURIComponent(issue.id)}/${archived ? 'archive' : 'restore'}`, { method: 'POST', headers: { 'If-Match': `"${issue.version}"` } })).data
}
