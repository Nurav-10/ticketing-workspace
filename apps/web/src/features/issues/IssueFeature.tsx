import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import './issues.css'
import { createIssue, getIssue, IssueApiError, listIssues, setIssueArchived, transitionIssue, updateIssue, type Issue, type IssueDetail, type IssuePriority, type IssueStatus } from './issue-api'
import { IssueDetailPanel } from './IssueDetailPanel'
import { IssueForm } from './IssueForm'
import { IssueList } from './IssueList'
import { appendIssueActivity, applyLatestIssueDetail, emptyIssueDraft, restoreHistoryEntry, type IssueDraft } from './issue-ui'
import { useAssigneeOptions } from './useAssigneeOptions'

type IssueView = 'list' | 'create' | 'detail'

const issueFromHash = () => {
  const match = /^#issue-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(location.hash)
  return match?.[1]
}

export function IssueFeature({ workspaceId, teamId, titleRef: pageTitleRef, onMutationPendingChange }: { workspaceId: string; teamId: string; titleRef: RefObject<HTMLHeadingElement | null>; onMutationPendingChange?: (pending: boolean) => void }) {
  const [items, setItems] = useState<Issue[]>([])
  const [selected, setSelected] = useState<IssueDetail | null>(null)
  const [view, setView] = useState<IssueView>('list')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingActivity, setLoadingActivity] = useState(false)
  const [activityError, setActivityError] = useState('')
  const [archived, setArchived] = useState(false)
  const archivedFilterRef = useRef(archived)
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(false)
  const [draft, setDraft] = useState<IssueDraft>(emptyIssueDraft)
  const [conflict, setConflict] = useState(false)
  const assignees = useAssigneeOptions(workspaceId, teamId, view === 'create' || (view === 'detail' && edit))
  const titleRef = useRef<HTMLInputElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const openRequestRef = useRef(0)
  const activityRequestRef = useRef(0)
  const mutationPendingRef = useRef(false)
  const mutationPendingCallbackRef = useRef(onMutationPendingChange)
  mutationPendingCallbackRef.current = onMutationPendingChange
  const navigationEntryRef = useRef({ state: history.state as unknown, url: `${location.pathname}${location.search}${location.hash}` })
  const idempotencyKeyRef = useRef<string | null>(null)
  const pendingCreateRef = useRef<{ title: string; description: string | null; priority: IssuePriority; assigneeUserId: string | null } | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const page = await listIssues(workspaceId, teamId, signal, undefined, archived)
      if (archivedFilterRef.current !== archived) return
      setItems(page.items)
      setNextCursor(page.nextCursor)
    } catch (caught) {
      if (!signal?.aborted && archivedFilterRef.current === archived) setError(caught instanceof Error ? caught.message : 'Could not load issues.')
    } finally {
      if (!signal?.aborted && archivedFilterRef.current === archived) setLoading(false)
    }
  }, [workspaceId, teamId, archived])

  const pushNavigation = (state: unknown, url: string) => {
    history.pushState(state, '', url)
    navigationEntryRef.current = { state: history.state as unknown, url: `${location.pathname}${location.search}${location.hash}` }
  }

  const setMutationPending = (pending: boolean) => {
    if (mutationPendingRef.current === pending) return
    if (pending) invalidateActivity()
    mutationPendingRef.current = pending
    mutationPendingCallbackRef.current?.(pending)
  }

  const invalidateActivity = () => {
    activityRequestRef.current += 1
    setLoadingActivity(false)
    setActivityError('')
  }

  const loadMoreActivity = async () => {
    const cursor = selected?.nextActivityCursor
    if (!selected || !cursor || loadingActivity || mutationPendingRef.current) return
    const issueId = selected.issue.id
    const requestId = ++activityRequestRef.current
    setLoadingActivity(true)
    setActivityError('')
    try {
      const page = await getIssue(workspaceId, teamId, issueId, undefined, cursor)
      if (requestId === activityRequestRef.current) setSelected((current) => appendIssueActivity(current, page, cursor))
    } catch (caught) {
      if (requestId === activityRequestRef.current) setActivityError(caught instanceof Error ? caught.message : 'Could not load more activity.')
    } finally {
      if (requestId === activityRequestRef.current) setLoadingActivity(false)
    }
  }

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const page = await listIssues(workspaceId, teamId, undefined, nextCursor, archived)
      if (archivedFilterRef.current !== archived) return
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))])
      setNextCursor(page.nextCursor)
    } catch (caught) {
      if (archivedFilterRef.current === archived) setError(caught instanceof Error ? caught.message : 'Could not load more issues.')
    } finally {
      setLoadingMore(false)
    }
  }

  async function open(id: string, push = true, allowDuringMutation = false) {
    if (mutationPendingRef.current && !allowDuringMutation) return
    invalidateActivity()
    const requestId = ++openRequestRef.current
    setBusy(true)
    setError('')
    setConflict(false)
    try {
      const detail = await getIssue(workspaceId, teamId, id)
      if (requestId !== openRequestRef.current) return
      setSelected(detail)
      setView('detail')
      setEdit(false)
      setDraft({ title: detail.issue.title, description: detail.issue.description ?? '', priority: detail.issue.priority, assigneeUserId: detail.issue.assigneeUserId })
      if (push) pushNavigation({ issueId: id }, `#issue-${encodeURIComponent(id)}`)
    } catch (caught) {
      if (requestId === openRequestRef.current) setError(caught instanceof Error ? caught.message : 'Could not load issue.')
    } finally {
      if (requestId === openRequestRef.current) setBusy(false)
    }
  }

  const close = () => {
    if (mutationPendingRef.current) return
    invalidateActivity()
    openRequestRef.current += 1
    setBusy(false)
    setView('list')
    setSelected(null)
    setEdit(false)
    setError('')
    setConflict(false)
    pushNavigation({}, location.pathname + location.search)
    createButtonRef.current?.focus()
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const id = issueFromHash()
    if (id) void open(id, false)
    return () => controller.abort()
  }, [refresh])

  useEffect(() => () => {
    openRequestRef.current += 1
    activityRequestRef.current += 1
    if (mutationPendingRef.current) {
      mutationPendingRef.current = false
      mutationPendingCallbackRef.current?.(false)
    }
  }, [])

  useEffect(() => {
    if (view === 'create' || edit) titleRef.current?.focus()
  }, [view, edit])

  useEffect(() => {
    const back = () => {
      if (mutationPendingRef.current) {
        restoreHistoryEntry(history, navigationEntryRef.current)
        return
      }
      navigationEntryRef.current = { state: history.state as unknown, url: `${location.pathname}${location.search}${location.hash}` }
      const id = issueFromHash()
      if (id) void open(id, false)
      else {
        invalidateActivity()
        openRequestRef.current += 1
        setBusy(false)
        setView('list')
        setSelected(null)
        setEdit(false)
      }
    }
    addEventListener('popstate', back)
    return () => removeEventListener('popstate', back)
  })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mutationPendingRef.current) return
    const form = event.currentTarget
    if (!form.reportValidity()) {
      (form.querySelector(':invalid') as HTMLElement | null)?.focus()
      return
    }
    const data = new FormData(form)
    const title = String(data.get('title') ?? '').trim()
    const description = String(data.get('description') ?? '') || null
    const priority = String(data.get('priority') ?? 'none') as IssuePriority
    const assigneeUserId = String(data.get('assigneeUserId') ?? '') || null
    const createPayload = { title, description, priority, assigneeUserId }
    if (view === 'create' && pendingCreateRef.current && JSON.stringify(pendingCreateRef.current) !== JSON.stringify(createPayload)) {
      setError('The earlier submission may have succeeded. Retry its original details or explicitly start a new request.')
      return
    }
    setBusy(true)
    setMutationPending(true)
    setError('')
    setConflict(false)
    try {
      if (view === 'create') {
        const key = idempotencyKeyRef.current ?? crypto.randomUUID()
        idempotencyKeyRef.current = key
        pendingCreateRef.current = createPayload
        const issue = await createIssue(workspaceId, teamId, createPayload, key)
        idempotencyKeyRef.current = null
        pendingCreateRef.current = null
        setNotice(`Created ${issue.key}`)
        setView('detail')
        pushNavigation({ issueId: issue.id }, `#issue-${encodeURIComponent(issue.id)}`)
        await open(issue.id, false, true)
        await refresh()
      } else if (selected) {
        const issue = await updateIssue(workspaceId, teamId, selected.issue, { title, description, priority, assigneeUserId })
        setSelected((current) => current && current.issue.id === issue.id ? { ...current, issue } : current)
        setDraft({ title: issue.title, description: issue.description ?? '', priority: issue.priority, assigneeUserId: issue.assigneeUserId })
        setEdit(false)
        setNotice('Issue saved')
        const detailRefreshError = await refreshMutatedDetail(issue.id)
        await refresh()
        if (detailRefreshError) setError(detailRefreshError)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save issue.')
      if (caught instanceof IssueApiError && caught.isVersionConflict) setConflict(true)
    } finally {
      setMutationPending(false)
      setBusy(false)
    }
  }

  const mutate = async (operation: () => Promise<Issue>, message: string) => {
    if (!selected || mutationPendingRef.current) return
    setBusy(true)
    setMutationPending(true)
    setError('')
    setConflict(false)
    try {
      const issue = await operation()
      setSelected((current) => current && current.issue.id === issue.id ? { ...current, issue } : current)
      setNotice(message)
      const detailRefreshError = await refreshMutatedDetail(issue.id)
      await refresh()
      if (detailRefreshError) setError(detailRefreshError)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update issue.')
      if (caught instanceof IssueApiError && caught.isVersionConflict) setConflict(true)
    } finally {
      setMutationPending(false)
      setBusy(false)
    }
  }

  const refreshMutatedDetail = async (issueId: string) => {
    try {
      const latest = await getIssue(workspaceId, teamId, issueId)
      setSelected((current) => applyLatestIssueDetail(current, latest))
      return ''
    } catch {
      return 'Issue updated, but its activity could not be refreshed. Reload this issue to see the latest activity.'
    }
  }

  const reapplyDraft = async () => {
    if (!selected) return
    invalidateActivity()
    const requestId = ++openRequestRef.current
    setBusy(true)
    try {
      const latest = await getIssue(workspaceId, teamId, selected.issue.id)
      if (requestId !== openRequestRef.current) return
      setSelected((current) => applyLatestIssueDetail(current, latest))
      setConflict(false)
      setError('')
      setEdit(true)
      setNotice('Latest version loaded. Review your draft before saving.')
    } catch (caught) {
      if (requestId === openRequestRef.current) setError(caught instanceof Error ? caught.message : 'Could not load the latest issue.')
    } finally {
      if (requestId === openRequestRef.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (!['create', 'detail'].includes(view)) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) close()
    }
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  })

  const startCreate = () => {
    if (mutationPendingRef.current) return
    invalidateActivity()
    openRequestRef.current += 1
    setBusy(false)
    setConflict(false)
    const pending = pendingCreateRef.current
    setDraft(pending ? { ...pending, description: pending.description ?? '' } : emptyIssueDraft())
    setError(pending ? 'The earlier submission may have succeeded. Retry its original details or explicitly start a new request.' : '')
    setView('create')
  }

  return <section className="issues-feature" aria-labelledby="issues-title">
    <header className="issues-heading"><div>
      <p className="issues-eyebrow">TEAM ISSUES</p>
      <h1 id="issues-title" ref={pageTitleRef} tabIndex={-1}>Issues</h1>
      <p>Track work for this team.</p>
    </div><button ref={createButtonRef} type="button" disabled={busy} onClick={startCreate}>Create issue</button></header>

    {notice && <p className="issues-notice" role="status">{notice}</p>}
    {error && <div className="issues-error" role="alert"><span>{error}</span>{view === 'create' && pendingCreateRef.current && <div>
      <button type="button" onClick={() => { const pending = pendingCreateRef.current; if (pending) setDraft({ ...pending, description: pending.description ?? '' }) }}>Restore submitted details</button>
      <button type="button" onClick={() => { if (confirm('Starting a new request could create a duplicate if the earlier submission succeeded. Continue?')) { idempotencyKeyRef.current = null; pendingCreateRef.current = null; setError('') } }}>Start new request</button>
    </div>}{conflict && selected && <div>
      <button type="button" disabled={busy} onClick={() => void open(selected.issue.id, false)}>Discard draft and reload</button>
      <button type="button" disabled={busy} onClick={() => void reapplyDraft()}>Reapply my draft</button>
    </div>}</div>}

    {view === 'list' && <IssueList
      items={items}
      loading={loading}
      loadingMore={loadingMore}
      nextCursor={nextCursor}
      archived={archived}
      busy={busy}
      onArchivedChange={(value) => {
        archivedFilterRef.current = value
        setItems([])
        setNextCursor(undefined)
        setLoading(true)
        setArchived(value)
      }}
      onRefresh={() => void refresh()}
      onOpen={(id) => void open(id)}
      onLoadMore={() => void loadMore()}
    />}
    {view === 'create' && <section className="issues-panel" aria-labelledby="create-heading">
      <button className="issues-back" type="button" disabled={busy} onClick={close}>← Back to issues</button>
      <h2 id="create-heading">Create issue</h2>
      <IssueForm
        draft={draft}
        titleRef={titleRef}
        busy={busy}
        submitLabel={busy ? 'Saving…' : 'Create issue'}
        assignees={assignees}
        onDraftChange={setDraft}
        onSubmit={submit}
        onCancel={close}
        onLoadMoreAssignees={() => void assignees.loadMore()}
        onRetryAssignees={assignees.retry}
      />
    </section>}
    {view === 'detail' && selected && <IssueDetailPanel
      selected={selected}
      edit={edit}
      busy={busy}
      draft={draft}
      assignees={assignees}
      titleRef={titleRef}
      onDraftChange={setDraft}
      onSubmit={submit}
      onClose={close}
      onEdit={() => setEdit(true)}
      onCancelEdit={() => setEdit(false)}
      onLoadMoreAssignees={() => void assignees.loadMore()}
      onRetryAssignees={assignees.retry}
      loadingActivity={loadingActivity}
      activityError={activityError}
      onLoadMoreActivity={() => void loadMoreActivity()}
      onStatusChange={(status: IssueStatus) => void mutate(() => transitionIssue(workspaceId, teamId, selected.issue, status), 'Status updated')}
      onToggleArchive={() => {
        if (selected.issue.archivedAt || confirm('Archive this issue? You can restore it later.')) {
          void mutate(() => setIssueArchived(workspaceId, teamId, selected.issue, !selected.issue.archivedAt), selected.issue.archivedAt ? 'Issue restored' : 'Issue archived')
        }
      }}
    />}
  </section>
}
