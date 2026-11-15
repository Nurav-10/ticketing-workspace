import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IssueApiError, searchIssues, type IssueSearchItem } from './issue-api'
import { label } from './issue-ui'

export function IssueSearchResults({ items, loading, busy = false, onOpen }: {
  items: IssueSearchItem[]; loading: boolean; busy?: boolean; onOpen?: (id: string) => void
}) {
  if (loading) return <p role="status">Searching issues…</p>
  if (!items.length) return <p className="issues-empty" role="status">No matching issues in this team.</p>
  return <ul className="issues-list">{items.map((issue) => <li key={issue.id}>
    <button type="button" className="issues-row issues-search-row" disabled={busy} onClick={() => onOpen?.(issue.id)}>
      <span className="issues-key">{issue.key}</span><span className="issues-title">{issue.title}</span>
      <span className={`issues-status status-${issue.status}`}>{label(issue.status)}</span>
      <span className="issues-priority">{label(issue.priority)}</span>{issue.archivedAt && <span>Archived</span>}
    </button>
  </li>)}</ul>
}

export function IssueSearch({ workspaceId, teamId, archived, visible, busy, onArchivedChange, onActiveChange, onOpen }: {
  workspaceId: string; teamId: string; archived: boolean; visible: boolean; busy: boolean
  onArchivedChange: (value: boolean) => void; onActiveChange: (value: boolean) => void; onOpen: (id: string) => void
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(false)
  const [items, setItems] = useState<IssueSearchItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const requestRef = useRef<AbortController | null>(null)

  useEffect(() => () => requestRef.current?.abort(), [])

  useEffect(() => {
    requestRef.current?.abort()
    if (!visible || !active) return
    const controller = new AbortController()
    requestRef.current = controller
    setItems([])
    setCursor(undefined)
    setError('')
    setLoadingMore(false)
    setLoading(true)
    void searchIssues(workspaceId, teamId, query, archived ? 'archived' : 'active', controller.signal)
      .then((page) => {
        if (requestRef.current !== controller || controller.signal.aborted) return
        setItems(page.items)
        setCursor(page.nextCursor)
      })
      .catch((caught: unknown) => {
        if (requestRef.current === controller && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Could not search issues.')
      })
      .finally(() => {
        if (requestRef.current === controller && !controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [workspaceId, teamId, query, archived, active, visible, revision])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const term = input.trim()
    if (!term) return
    setQuery(term)
    setActive(true)
    onActiveChange(true)
    setRevision((value) => value + 1)
  }
  const clear = () => {
    requestRef.current?.abort()
    setInput('')
    setQuery('')
    setActive(false)
    setItems([])
    setCursor(undefined)
    setError('')
    onActiveChange(false)
  }
  const loadMore = async () => {
    if (!cursor || loadingMore || loading) return
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setLoadingMore(true)
    setError('')
    try {
      const page = await searchIssues(workspaceId, teamId, query, archived ? 'archived' : 'active', controller.signal, cursor)
      if (requestRef.current !== controller || controller.signal.aborted) return
      setItems((previous) => [...previous, ...page.items.filter((item) => !previous.some((old) => old.id === item.id))])
      setCursor(page.nextCursor)
    } catch (caught) {
      if (requestRef.current === controller && !controller.signal.aborted) {
        setError(caught instanceof IssueApiError && caught.code === 'stale_cursor'
          ? 'Results changed. Refresh the search to continue.'
          : caught instanceof Error ? caught.message : 'Could not load more results.')
      }
    } finally {
      if (requestRef.current === controller && !controller.signal.aborted) setLoadingMore(false)
    }
  }

  return <section className="issues-search" hidden={!visible} aria-label="Issue search">
    <form className="issues-search-form" role="search" onSubmit={submit}>
      <label htmlFor="issue-search-input">Search issues</label>
      <div><input id="issue-search-input" type="search" maxLength={200} value={input} onChange={(event) => setInput(event.target.value)} placeholder="Search titles and descriptions" />
        <button type="submit" disabled={busy || !input.trim()}>Search</button>
        {active && <button className="secondary" type="button" disabled={busy} onClick={clear}>Clear search</button>}</div>
    </form>
    {active && <>
      <div className="issues-list-head"><h2>Search results</h2><button type="button" className="secondary" disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}>Refresh</button></div>
      <fieldset className="issues-scope-toggle" aria-label="Search archive filter"><legend>Search in</legend>
        <label><input type="radio" name="search-archive-filter" checked={!archived} disabled={busy} onChange={() => onArchivedChange(false)} />Active</label>
        <label><input type="radio" name="search-archive-filter" checked={archived} disabled={busy} onChange={() => onArchivedChange(true)} />Archived</label>
      </fieldset>
      {error && <p className="issues-error" role="alert">{error}</p>}
      {(loading || !error || items.length > 0) && <IssueSearchResults items={items} loading={loading} busy={busy} onOpen={onOpen} />}
      {cursor && !error && <button type="button" className="secondary" disabled={loadingMore || busy} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more results'}</button>}
    </>}
  </section>
}
