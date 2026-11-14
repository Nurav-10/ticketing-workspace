import type { Issue } from './issue-api'
import { label } from './issue-ui'

export function IssueList({
  items,
  loading,
  loadingMore,
  nextCursor,
  archived,
  busy,
  onArchivedChange,
  onRefresh,
  onOpen,
  onLoadMore,
}: {
  items: Issue[]
  loading: boolean
  loadingMore: boolean
  nextCursor?: string
  archived: boolean
  busy: boolean
  onArchivedChange: (archived: boolean) => void
  onRefresh: () => void
  onOpen: (id: string) => void
  onLoadMore: () => void
}) {
  return <>
    <div className="issues-list-head"><h2>{archived ? 'Archived issues' : 'Team issues'}</h2><button type="button" onClick={onRefresh} disabled={loading}>Refresh</button></div>
    <fieldset className="issues-scope-toggle" aria-label="Issue archive filter">
      <legend>Show issues</legend>
      <label><input type="radio" name="issue-archive-filter" checked={!archived} onChange={() => onArchivedChange(false)} />Active</label>
      <label><input type="radio" name="issue-archive-filter" checked={archived} onChange={() => onArchivedChange(true)} />Archived</label>
    </fieldset>
    {loading ? <p role="status">Loading issues…</p> : items.length === 0 ? <p className="issues-empty">{archived ? 'No archived issues in this team.' : 'No open issues in this team yet.'}</p> : <>
      <ul className="issues-list">{items.map((issue) => <li key={issue.id}>
        <button type="button" className="issues-row" disabled={busy} onClick={() => onOpen(issue.id)}>
          <span className="issues-key">{issue.key}</span><span className="issues-title">{issue.title}</span>
          <span className={`issues-status status-${issue.status}`}>{label(issue.status)}</span>
          <span className="issues-priority">{label(issue.priority)}</span>{issue.archivedAt && <span>Archived</span>}
        </button>
      </li>)}</ul>
      {nextCursor && <button type="button" className="secondary" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more issues'}</button>}
    </>}
  </>
}
