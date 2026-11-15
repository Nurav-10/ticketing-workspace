import type { Issue, IssueDetail, IssuePriority, IssueStatus } from './issue-api'

export const statuses: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'done', 'canceled']

export const transitions: Record<IssueStatus, IssueStatus[]> = {
  backlog: ['todo', 'canceled'],
  todo: ['backlog', 'in_progress', 'canceled'],
  in_progress: ['todo', 'done', 'canceled'],
  done: ['todo'],
  canceled: ['backlog', 'todo'],
}

export const priorities: IssuePriority[] = ['none', 'low', 'medium', 'high', 'urgent']

export const label = (value: string) => value.replaceAll('_', ' ')
export const assigneeLabel = (issue: Pick<Issue, 'assigneeUserId' | 'assignee'>) =>
  issue.assigneeUserId ? issue.assignee?.displayName ?? 'Unavailable member' : 'Unassigned'
export const activityLabel = (event: IssueDetail['activity'][number]) => {
  const metadata = event.metadata ?? {}
  if (event.kind === 'status_changed') {
    const before = metadata.statusBefore
    const after = metadata.statusAfter
    if (typeof before === 'string' && typeof after === 'string' && statuses.includes(before as IssueStatus) && statuses.includes(after as IssueStatus)) {
      return `Status changed from ${label(before)} to ${label(after)}`
    }
    return 'Status changed'
  }
  if (event.kind === 'fields_changed') {
    const names: Record<string, string> = { title: 'title', description: 'description', priority: 'priority', assigneeUserId: 'assignee' }
    const fields = Array.isArray(metadata.changedFields) ? metadata.changedFields.filter((field): field is string => typeof field === 'string' && Object.hasOwn(names, field)).map((field) => names[field]) : []
    return fields.length ? `Changed ${fields.join(', ')}` : 'Issue updated'
  }
  return ({ created: 'Issue created', archived: 'Issue archived', restored: 'Issue restored' } as Record<string, string>)[event.kind] ?? 'Issue activity'
}

export type IssueDraft = { title: string; description: string; priority: IssuePriority; assigneeUserId: string | null }

export const emptyIssueDraft = (): IssueDraft => ({ title: '', description: '', priority: 'none', assigneeUserId: null })

export const applyLatestIssueDetail = (current: IssueDetail | null, latest: IssueDetail): IssueDetail | null =>
  current?.issue.id === latest.issue.id ? latest : current

export const appendIssueActivity = (current: IssueDetail | null, page: IssueDetail, cursor: string): IssueDetail | null => {
  if (!current || current.issue.id !== page.issue.id || current.nextActivityCursor !== cursor) return current
  const seen = new Set(current.activity.map((event) => event.id))
  const activity = [...current.activity]
  for (const event of page.activity) {
    if (!seen.has(event.id)) { activity.push(event); seen.add(event.id) }
  }
  const { nextActivityCursor: _previous, ...detail } = current
  return { ...detail, activity, ...(page.nextActivityCursor ? { nextActivityCursor: page.nextActivityCursor } : {}) }
}

export type IssueHistoryEntry = { state: unknown; url: string }

export const restoreHistoryEntry = (history: Pick<History, 'pushState'>, entry: IssueHistoryEntry) =>
  history.pushState(entry.state, '', entry.url)
