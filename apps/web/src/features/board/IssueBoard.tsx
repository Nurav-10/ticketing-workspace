import { useMemo, useState, type DragEvent } from 'react'
import './issue-board.css'

/** Canonical workflow column supplied by the authorized workflow read API. */
export type BoardColumn = {
  id: string
  name: string
  category: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
  position: number
  /** Version of this status group's shared order, supplied by the server. */
  orderVersion: number
  /** Target status IDs allowed by the workflow graph from this column. */
  allowedTargetStatusIds: string[]
}

/** Minimal canonical issue data required to render and safely move a card. */
export type BoardIssue = {
  id: string
  key: string
  title: string
  workflowStatusId: string
  version: number
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  assigneeName?: string | null
}

export type BoardPlacement =
  | { beforeIssueId: string }
  | { afterIssueId: string }
  | { append: true }

export type BoardMoveIntent = {
  issueId: string
  targetStatusId: string
  placement: BoardPlacement
  expectedIssueVersion: number
  expectedOrderVersions: { statusId: string; version: number }[]
}

export type BoardMoveResult =
  | { ok: true; issue?: BoardIssue }
  | { ok: false; kind: 'conflict' | 'error'; message?: string }

export type BoardSnapshot = { issues: BoardIssue[]; columns: BoardColumn[] }

export type IssueBoardProps = {
  columns: BoardColumn[]
  issues: BoardIssue[]
  loading?: boolean
  error?: string | null
  onRefresh: () => Promise<BoardSnapshot> | BoardSnapshot
  onOpenIssue?: (issueId: string) => void
  onMoveIssue: (intent: BoardMoveIntent) => Promise<BoardMoveResult>
}

type FailedMove = { intent: BoardMoveIntent; message: string }

const priorityLabel: Record<NonNullable<BoardIssue['priority']>, string> = {
  none: 'No priority', low: 'Low priority', medium: 'Medium priority', high: 'High priority', urgent: 'Urgent priority',
}

function failureMessage(result: Extract<BoardMoveResult, { ok: false }>) {
  return result.message || (result.kind === 'conflict'
    ? 'This issue changed elsewhere. Refresh the board, then reapply your move.'
    : 'The issue could not be moved. Your board has not been changed locally.')
}

export function IssueBoard({
  columns,
  issues,
  loading = false,
  error = null,
  onRefresh,
  onOpenIssue,
  onMoveIssue,
}: IssueBoardProps) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set())
  const [failure, setFailure] = useState<FailedMove | null>(null)
  const [refreshedAfterFailure, setRefreshedAfterFailure] = useState(false)
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshedIssues, setRefreshedIssues] = useState<BoardIssue[] | null>(null)
  const [refreshedColumns, setRefreshedColumns] = useState<BoardColumn[] | null>(null)
  const orderedColumns = useMemo(() => [...columns].sort((a, b) => a.position - b.position), [columns])
  const byColumn = useMemo(() => {
    const groups = new Map<string, BoardIssue[]>(orderedColumns.map((column): [string, BoardIssue[]] => [column.id, []]))
    for (const issue of issues) groups.get(issue.workflowStatusId)?.push(issue)
    return groups
  }, [issues, orderedColumns])

  function buildIntent(issue: BoardIssue, targetStatusId: string, placement: BoardPlacement, availableColumns = orderedColumns): BoardMoveIntent | null {
    const statusIds = [...new Set([issue.workflowStatusId, targetStatusId])].sort()
    const versions = statusIds.map((statusId) => {
      const column = availableColumns.find((item) => item.id === statusId)
      return column ? { statusId, version: column.orderVersion } : null
    })
    if (versions.some((item) => item === null)) {
      setNotice('Board status information is out of date. Refresh before moving this issue.')
      return null
    }
    return { issueId: issue.id, targetStatusId, placement, expectedIssueVersion: issue.version,
      expectedOrderVersions: versions as { statusId: string; version: number }[] }
  }

  function requestMove(issue: BoardIssue, targetStatusId: string, placement: BoardPlacement) {
    const intent = buildIntent(issue, targetStatusId, placement)
    if (intent) void move(intent)
  }

  async function move(intent: BoardMoveIntent) {
    if (pendingIds.has(intent.issueId)) return
    setPendingIds((current) => new Set(current).add(intent.issueId))
    setFailure(null)
    setRefreshedAfterFailure(false)
    setNotice('')
    try {
      const result = await onMoveIssue(intent)
      if (!result.ok) {
        setFailure({ intent, message: failureMessage(result) })
        setRefreshedAfterFailure(false)
        return
      }
      const movedIssue = result.issue ?? issues.find((issue) => issue.id === intent.issueId)
      const column = orderedColumns.find((item) => item.id === intent.targetStatusId)
      setNotice(movedIssue && column ? `${movedIssue.key} moved to ${column.name}.` : 'Issue move saved.')
    } catch {
      setFailure({ intent, message: 'The move could not be confirmed. Refresh the board before trying again.' })
      setRefreshedAfterFailure(false)
    } finally {
      setPendingIds((current) => { const next = new Set(current); next.delete(intent.issueId); return next })
    }
  }

  async function refreshForRetry() {
    if (!failure || refreshing) return
    await refreshBoard()
  }

  async function refreshBoard() {
    if (refreshing) return
    setRefreshing(true)
    setNotice('')
    try {
      const refreshed = await onRefresh()
      setRefreshedIssues(refreshed.issues)
      setRefreshedColumns(refreshed.columns)
      if (failure) setRefreshedAfterFailure(true)
      setNotice(failure ? 'Board refreshed. Reapply the move if it is still needed.' : 'Board refreshed.')
    } catch {
      setNotice('Could not refresh the board. Check your connection and retry.')
    } finally {
      setRefreshing(false)
    }
  }

  async function reapplyMove() {
    if (!failure) return
    const intent = failure.intent
    const current = (refreshedIssues ?? issues).find((issue) => issue.id === intent.issueId)
    if (!current) {
      setNotice('This issue is no longer in the current board results. Refresh the board.')
      setFailure(null)
      return
    }
    const refreshedIntent = buildIntent(current, intent.targetStatusId, intent.placement, refreshedColumns ?? orderedColumns)
    if (refreshedIntent) await move(refreshedIntent)
  }

  function handleDrop(event: DragEvent<HTMLElement>, column: BoardColumn, beforeIssueId?: string) {
    event.preventDefault()
    event.stopPropagation()
    const issueId = event.dataTransfer.getData('text/issue-id')
    const issue = issues.find((item) => item.id === issueId)
    if (!issue || issueId === beforeIssueId || (issue.workflowStatusId !== column.id && !canMove(issue, column.id))) return
    const placement: BoardPlacement = beforeIssueId ? { beforeIssueId } : { append: true }
    requestMove(issue, column.id, placement)
  }

  function canMove(issue: BoardIssue, targetStatusId: string) {
    return orderedColumns.find((column) => column.id === issue.workflowStatusId)?.allowedTargetStatusIds.includes(targetStatusId) ?? false
  }

  return <section className="issue-board" aria-label="Issues by workflow status" aria-busy={loading || pendingIds.size > 0}>
    <div className="issue-board__toolbar">
      <p className="issue-board__hint">Move issues with the controls on each card. Drag a card before another issue or to the end of a column.</p>
      <button className="issue-board__button" type="button" onClick={() => void refreshBoard()} disabled={loading || refreshing}>
        {loading || refreshing ? 'Refreshing…' : 'Refresh board'}
      </button>
    </div>

    {error && <div className="issue-board__error" role="alert">
      <span>{error}</span>
      <button className="issue-board__button" type="button" onClick={() => void refreshBoard()} disabled={loading || refreshing}>Try again</button>
    </div>}
    {failure && <div className="issue-board__error" role="alert">
      <span>{failure.message}</span>
      <button className="issue-board__button" type="button" onClick={() => void refreshForRetry()} disabled={refreshing}>Refresh board</button>
      <button className="issue-board__button issue-board__button--primary" type="button" onClick={() => void reapplyMove()} disabled={!refreshedAfterFailure || pendingIds.has(failure.intent.issueId)}>Reapply move</button>
      <button className="issue-board__dismiss" type="button" aria-label="Dismiss move message" onClick={() => setFailure(null)}>×</button>
    </div>}

    <p className="issue-board__sr-only" role="status" aria-live="polite" aria-atomic="true">{notice}</p>
    {loading && issues.length === 0 ? <p className="issue-board__state" role="status">Loading issues…</p>
      : error && issues.length === 0 ? <p className="issue-board__state">The board could not be loaded.</p>
        : <div className="issue-board__columns" role="list" aria-label="Workflow columns">
          {orderedColumns.map((column) => {
            const columnIssues = byColumn.get(column.id) ?? []
            return <section
              className="issue-board__column"
              key={column.id}
              role="listitem"
              aria-label={`${column.name}, ${columnIssues.length} visible ${columnIssues.length === 1 ? 'issue' : 'issues'}`}
              onDragOver={(event) => { if (event.dataTransfer.types.includes('text/issue-id')) event.preventDefault() }}
              onDrop={(event) => handleDrop(event, column)}
            >
              <header className="issue-board__column-header">
                <div className="issue-board__column-title"><h2>{column.name}</h2><span aria-label={`${columnIssues.length} visible issues`}>{columnIssues.length}</span></div>
                <span className="issue-board__category">{column.category}</span>
              </header>
              {loading && <p className="issue-board__column-note">Updating issues…</p>}
              {!loading && columnIssues.length === 0 && <p className="issue-board__empty">No issues</p>}
              <ul className="issue-board__cards">
                {columnIssues.map((issue) => <li key={issue.id}
                  onDragOver={(event) => { if (event.dataTransfer.types.includes('text/issue-id')) event.preventDefault() }}
                  onDrop={(event) => handleDrop(event, column, issue.id)}>
                  <IssueCard
                    issue={issue}
                    columns={orderedColumns}
                    allIssues={issues}
                    pending={pendingIds.has(issue.id)}
                    onMove={(targetStatusId, placement) => requestMove(issue, targetStatusId, placement)}
                    onOpen={onOpenIssue}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/issue-id', issue.id)
                    }}
                  />
                </li>)}
              </ul>
            </section>
          })}
        </div>}
  </section>
}

function IssueCard({
  issue,
  columns,
  allIssues,
  pending,
  onMove,
  onOpen,
  onDragStart,
}: {
  issue: BoardIssue
  columns: BoardColumn[]
  allIssues: BoardIssue[]
  pending: boolean
  onMove: (targetStatusId: string, placement: BoardPlacement) => void
  onOpen?: (issueId: string) => void
  onDragStart: (event: DragEvent<HTMLElement>) => void
}) {
  const [targetStatusId, setTargetStatusId] = useState(issue.workflowStatusId)
  const [placementValue, setPlacementValue] = useState('end')
  const targets = columns.filter((column) => column.id === issue.workflowStatusId || columns.find((source) => source.id === issue.workflowStatusId)?.allowedTargetStatusIds.includes(column.id))
  const targetIssues = allIssues.filter((item) => item.workflowStatusId === targetStatusId)
  const placements: Array<{ value: string; label: string; placement: BoardPlacement }> = [
    { value: 'end', label: 'At end of column', placement: { append: true } },
    ...targetIssues.filter((item) => item.id !== issue.id).flatMap((item) => [
      { value: `before:${item.id}`, label: `Before ${item.key} · ${item.title}`, placement: { beforeIssueId: item.id } as BoardPlacement },
      { value: `after:${item.id}`, label: `After ${item.key} · ${item.title}`, placement: { afterIssueId: item.id } as BoardPlacement },
    ]),
  ]
  const priority = issue.priority ? priorityLabel[issue.priority] : null

  return <article className="issue-board__card" draggable={!pending} onDragStart={onDragStart}>
    <div className="issue-board__card-heading">
      {onOpen ? <button className="issue-board__open" type="button" onClick={() => onOpen(issue.id)} disabled={pending} aria-label={`Open ${issue.key}: ${issue.title}`}>
        <span className="issue-board__key">{issue.key}</span><span className="issue-board__title">{issue.title}</span>
      </button> : <div><span className="issue-board__key">{issue.key}</span><span className="issue-board__title">{issue.title}</span></div>}
      <span className="issue-board__drag-cue" aria-hidden="true" title="Drag to move to another column">⠿</span>
    </div>
    {(priority || issue.assigneeName) && <div className="issue-board__metadata">
      {priority && <span className={`issue-board__priority issue-board__priority--${issue.priority}`} title={priority}>{priority}</span>}
      {issue.assigneeName && <span className="issue-board__assignee">{issue.assigneeName}</span>}
    </div>}
    <form className="issue-board__move" onSubmit={(event) => {
      event.preventDefault()
      const selection = placements.find((item) => item.value === placementValue)
      if (selection) onMove(targetStatusId, selection.placement)
    }}>
      <label className="issue-board__sr-only" htmlFor={`board-target-${issue.id}`}>Move {issue.key} to status</label>
      <select id={`board-target-${issue.id}`} value={targetStatusId} onChange={(event) => { setTargetStatusId(event.target.value); setPlacementValue('end') }} disabled={pending}>
        {targets.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
      </select>
      <label className="issue-board__sr-only" htmlFor={`board-placement-${issue.id}`}>Position relative to an issue</label>
      <select id={`board-placement-${issue.id}`} value={placementValue} onChange={(event) => setPlacementValue(event.target.value)} disabled={pending}>
        {placements.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <button className="issue-board__move-button" type="submit" disabled={pending}>
        {pending ? 'Moving…' : 'Move'}<span className="issue-board__sr-only"> {issue.key}</span>
      </button>
    </form>
  </article>
}
