import type { IssuePriority, IssueStatus } from './issue-api'

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

export type IssueDraft = { title: string; description: string; priority: IssuePriority; assigneeUserId: string | null }

export const emptyIssueDraft = (): IssueDraft => ({ title: '', description: '', priority: 'none', assigneeUserId: null })
