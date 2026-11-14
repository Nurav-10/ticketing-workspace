import type { FormEvent, RefObject } from 'react'
import type { IssueDetail, IssueStatus } from './issue-api'
import type { AssigneeOption } from './assignee-api'
import { IssueForm } from './IssueForm'
import { label, statuses, transitions, type IssueDraft } from './issue-ui'

export function IssueDetailPanel({
  selected,
  edit,
  busy,
  draft,
  assignees,
  titleRef,
  onDraftChange,
  onSubmit,
  onClose,
  onEdit,
  onCancelEdit,
  onStatusChange,
  onToggleArchive,
  onLoadMoreAssignees,
  onRetryAssignees,
}: {
  selected: IssueDetail
  edit: boolean
  busy: boolean
  draft: IssueDraft
  assignees: { items: AssigneeOption[]; nextCursor?: string; loading: boolean; loadingMore: boolean; error: string }
  titleRef: RefObject<HTMLInputElement | null>
  onDraftChange: (draft: IssueDraft) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onClose: () => void
  onEdit: () => void
  onCancelEdit: () => void
  onStatusChange: (status: IssueStatus) => void
  onToggleArchive: () => void
  onLoadMoreAssignees: () => void
  onRetryAssignees: () => void
}) {
  const issue = selected.issue

  return <article className="issues-panel" aria-labelledby="detail-heading">
    <button className="issues-back" type="button" onClick={onClose}>← Back to issues</button>
    <div className="issues-detail-heading"><div><p className="issues-key">{issue.key}</p><h2 id="detail-heading">{issue.title}</h2></div><span>Version {issue.version}</span></div>
    {edit ? <IssueForm
      draft={draft}
      titleRef={titleRef}
      busy={busy}
      submitLabel={busy ? 'Saving…' : 'Save changes'}
      assignees={assignees}
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
      onCancel={onCancelEdit}
      onLoadMoreAssignees={onLoadMoreAssignees}
      onRetryAssignees={onRetryAssignees}
    /> : <>
      <p className="issues-description">{issue.description || 'No description.'}</p>
      <dl className="issues-meta"><div><dt>Status</dt><dd>{label(issue.status)}</dd></div><div><dt>Priority</dt><dd>{label(issue.priority)}</dd></div><div><dt>Updated</dt><dd>{new Date(issue.updatedAt).toLocaleString()}</dd></div></dl>
      <div className="issues-actions">
        <button type="button" disabled={Boolean(issue.archivedAt)} onClick={onEdit}>Edit</button>
        <label>Change status<select aria-label="Change status" value={issue.status} disabled={busy || Boolean(issue.archivedAt)} onChange={(event) => onStatusChange(event.target.value as IssueStatus)}>
          {statuses.filter((status) => status === issue.status || transitions[issue.status].includes(status)).map((status) => <option key={status} value={status}>{label(status)}</option>)}
        </select></label>
        <button className="secondary" disabled={busy} type="button" onClick={onToggleArchive}>{issue.archivedAt ? 'Restore issue' : 'Archive issue'}</button>
      </div>
    </>}
    <section className="issues-history"><h3>Activity</h3>{selected.activity.length ? <ul>{selected.activity.map((event) => <li key={event.id}>{label(event.kind)} · {new Date(event.createdAt).toLocaleString()}</li>)}</ul> : <p>No activity recorded.</p>}</section>
  </article>
}
