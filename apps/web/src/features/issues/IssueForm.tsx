import { useId, useState, type FormEvent, type RefObject } from 'react'
import type { IssuePriority } from './issue-api'
import type { AssigneeOption } from './assignee-api'
import { label, priorities, type IssueDraft } from './issue-ui'

export function IssueForm({
  draft,
  titleRef,
  busy,
  submitLabel,
  assignees,
  onDraftChange,
  onSubmit,
  onCancel,
  onLoadMoreAssignees,
  onRetryAssignees,
}: {
  draft: IssueDraft
  titleRef: RefObject<HTMLInputElement | null>
  busy: boolean
  submitLabel: string
  assignees: { items: AssigneeOption[]; nextCursor?: string; loading: boolean; loadingMore: boolean; error: string }
  onDraftChange: (draft: IssueDraft) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCancel: () => void
  onLoadMoreAssignees: () => void
  onRetryAssignees: () => void
}) {
  const titleHelpId = useId()
  const [titleTouched, setTitleTouched] = useState(false)
  const titleInvalid = titleTouched && draft.title.trim().length === 0
  const currentAssignee = draft.assigneeUserId && !assignees.items.some((assignee) => assignee.id === draft.assigneeUserId)
    ? draft.assigneeUserId
    : null

  return <form onSubmit={onSubmit}>
    <label>Title<input ref={titleRef} name="title" required pattern=".*\S.*" maxLength={250} value={draft.title} onChange={(event) => onDraftChange({ ...draft, title: event.target.value })} onBlur={() => setTitleTouched(true)} onInvalid={() => setTitleTouched(true)} aria-invalid={titleInvalid || undefined} aria-describedby={titleHelpId} /><span id={titleHelpId}>{titleInvalid ? 'Enter a title containing a non-space character.' : 'Required, up to 250 characters.'}</span></label>
    <label>Description<textarea name="description" maxLength={20000} rows={6} value={draft.description} onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} /></label>
    <label>Priority<select name="priority" value={draft.priority} onChange={(event) => onDraftChange({ ...draft, priority: event.target.value as IssuePriority })}>{priorities.map((priority) => <option key={priority} value={priority}>{label(priority)}</option>)}</select></label>
    <label>Assignee<select name="assigneeUserId" value={draft.assigneeUserId ?? ''} onChange={(event) => onDraftChange({ ...draft, assigneeUserId: event.target.value || null })}>
      <option value="">Unassigned</option>
      {currentAssignee && <option value={currentAssignee}>Current assignee (not in loaded list)</option>}
      {assignees.items.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}
    </select></label>
    {assignees.loading && <p role="status">Loading team members…</p>}
    {assignees.error && <div role="alert"><span>{assignees.error}</span> <button type="button" className="secondary" onClick={onRetryAssignees}>Retry loading assignees</button></div>}
    {assignees.nextCursor && <button type="button" className="secondary" disabled={assignees.loadingMore} onClick={onLoadMoreAssignees}>{assignees.loadingMore ? 'Loading…' : 'Load more assignees'}</button>}
    <div className="issues-form-actions">
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      <button disabled={busy} type="submit">{submitLabel}</button>
    </div>
  </form>
}
