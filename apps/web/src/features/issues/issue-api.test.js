import { describe, expect, it } from 'bun:test'
import { getIssue, IssueApiError } from './issue-api'
import { activityLabel, appendIssueActivity, applyLatestIssueDetail, assigneeLabel, restoreHistoryEntry } from './issue-ui'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IssueList } from './IssueList'
import { IssueDetailPanel } from './IssueDetailPanel'
import { IssueForm } from './IssueForm'

describe('issue assignee presentation', () => {
  it('distinguishes an available assignee, an unavailable former assignee, and no assignee', () => {
    expect(assigneeLabel({ assigneeUserId: 'user-1', assignee: { id: 'user-1', displayName: 'Alex' } })).toBe('Alex')
    expect(assigneeLabel({ assigneeUserId: 'user-1', assignee: null })).toBe('Unavailable member')
    expect(assigneeLabel({ assigneeUserId: null, assignee: null })).toBe('Unassigned')
  })

  it('shows the assignee in the issue list', () => {
    const issue = { id: 'issue-1', key: 'ENG-1', title: 'Write tests', status: 'todo', priority: 'none', assigneeUserId: 'user-1', assignee: { id: 'user-1', displayName: 'Alex' }, archivedAt: null }
    const html = renderToStaticMarkup(createElement(IssueList, { items: [issue], loading: false, loadingMore: false, archived: false, busy: false, onArchivedChange() {}, onRefresh() {}, onOpen() {}, onLoadMore() {} }))
    expect(html).toContain('Assignee: Alex')
  })

  it('offers older activity and shows the assignee in issue detail', () => {
    const issue = { id: 'issue-1', key: 'ENG-1', title: 'Write tests', version: 1, status: 'todo', priority: 'none', assigneeUserId: 'user-1', assignee: { id: 'user-1', displayName: 'Alex' }, archivedAt: null, updatedAt: '2026-01-01T00:00:00Z' }
    const html = renderToStaticMarkup(createElement(IssueDetailPanel, { selected: { issue, activity: [], nextActivityCursor: 'cursor' }, edit: false, busy: false, loadingActivity: false, activityError: '', draft: {}, assignees: {}, titleRef: { current: null } }))
    expect(html).toContain('<dt>Assignee</dt><dd>Alex</dd>')
    expect(html).toContain('Load earlier activity')
  })

  it('shows the actor for activity and a fallback for a former member', () => {
    const issue = { id: 'issue-1', key: 'ENG-1', title: 'Write tests', version: 1, status: 'todo', priority: 'none', assigneeUserId: null, archivedAt: null, updatedAt: '2026-01-01T00:00:00Z' }
    const activity = [{ id: 'a', kind: 'created', metadata: {}, actor: { id: 'user-1', displayName: 'Alex' }, createdAt: '2026-01-01T00:00:00Z' }, { id: 'b', kind: 'archived', metadata: {}, actor: null, createdAt: '2026-01-01T00:00:00Z' }]
    const html = renderToStaticMarkup(createElement(IssueDetailPanel, { selected: { issue, activity }, edit: false, busy: false, loadingActivity: false, activityError: '', draft: {}, assignees: {}, titleRef: { current: null } }))
    expect(html).toContain('Alex')
    expect(html).toContain('Unavailable member')
  })

  it('keeps a known assignee name visible while its option page is not loaded', () => {
    const html = renderToStaticMarkup(createElement(IssueForm, { draft: { title: 'Issue', description: '', priority: 'none', assigneeUserId: 'user-1' }, currentAssigneeSummary: { id: 'user-1', displayName: 'Alex' }, assignees: { items: [], loading: false, loadingMore: false, error: '' }, titleRef: { current: null }, busy: false, submitLabel: 'Save' }))
    expect(html).toContain('>Alex</option>')
  })
})

describe('issue activity pages', () => {
  it('describes allowed status and field changes without echoing unknown metadata', () => {
    expect(activityLabel({ kind: 'status_changed', metadata: { statusBefore: 'todo', statusAfter: 'in_progress' } })).toBe('Status changed from todo to in progress')
    expect(activityLabel({ kind: 'fields_changed', metadata: { changedFields: ['title', 'priority', 'unexpected'] } })).toBe('Changed title, priority')
    expect(activityLabel({ kind: 'status_changed', metadata: { statusBefore: '<unsafe>', statusAfter: 'done' } })).toBe('Status changed')
    expect(activityLabel({ kind: 'labels_changed', metadata: { addedLabelIds: ['label-1'], removedLabelIds: [] } })).toBe('Labels updated')
  })
  it('appends unique events only to the same issue and cursor', () => {
    const current = { issue: { id: 'issue-1', version: 3 }, activity: [{ id: 'a' }, { id: 'b' }], nextActivityCursor: 'cursor-1' }
    const page = { issue: { id: 'issue-1', version: 2 }, activity: [{ id: 'b' }, { id: 'c' }], nextActivityCursor: 'cursor-2' }
    expect(appendIssueActivity(current, page, 'cursor-1')).toEqual({ issue: current.issue, activity: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextActivityCursor: 'cursor-2' })
    expect(appendIssueActivity(current, page, 'old-cursor')).toBe(current)
    expect(appendIssueActivity({ ...current, issue: { id: 'other' } }, page, 'cursor-1').activity).toEqual(current.activity)
    const finalPage = appendIssueActivity(current, { issue: current.issue, activity: [{ id: 'c' }] }, 'cursor-1')
    expect(finalPage.nextActivityCursor).toBeUndefined()
  })
  it('requests the next activity cursor in the scoped detail URL', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl
    globalThis.fetch = async (url) => {
      requestedUrl = url
      return new Response(JSON.stringify({ data: { issue: { id: 'issue-1' }, activity: [], nextActivityCursor: 'next' } }), { status: 200 })
    }
    try {
      const result = await getIssue('workspace', 'team', 'issue-1', undefined, 'cursor+/=')
      expect(requestedUrl).toBe('/api/v1/workspaces/workspace/teams/team/issues/issue-1?activityCursor=cursor%2B%2F%3D')
      expect(result.nextActivityCursor).toBe('next')
    } finally { globalThis.fetch = originalFetch }
  })
})

describe('IssueApiError version conflict classification', () => {
  it('recognizes the explicit version conflict response', () => {
    expect(new IssueApiError('stale issue', 409, 'version_conflict').isVersionConflict).toBe(true)
  })

  it('does not classify other conflict responses as stale versions', () => {
    expect(new IssueApiError('conflict', 409, 'idempotency_conflict').isVersionConflict).toBe(false)
    expect(new IssueApiError('bad request', 400, 'version_conflict').isVersionConflict).toBe(false)
  })
})

describe('issue detail mutation refresh', () => {
  it('replaces activity from the latest snapshot for the selected issue', () => {
    const latest = { issue: { id: 'issue-1', version: 2 }, activity: [{ id: 'event-2' }] }
    const current = { issue: { id: 'issue-1', version: 1 }, activity: [{ id: 'event-1' }] }

    expect(applyLatestIssueDetail(current, latest)).toBe(latest)
  })

  it('does not replace a different issue selected while the refresh was pending', () => {
    const current = { issue: { id: 'issue-2', version: 1 }, activity: [] }
    const stale = { issue: { id: 'issue-1', version: 2 }, activity: [{ id: 'event-2' }] }

    expect(applyLatestIssueDetail(current, stale)).toBe(current)
  })
})

describe('blocked browser navigation', () => {
  it('restores the current entry state together with its URL', () => {
    const calls = []
    const history = { state: { page: 'list' }, pushState: (...args) => calls.push(args) }
    const currentEntry = { state: { issueId: 'issue-2' }, url: '/issues#issue-2' }

    restoreHistoryEntry(history, currentEntry)

    expect(calls).toEqual([[currentEntry.state, '', currentEntry.url]])
  })
})
