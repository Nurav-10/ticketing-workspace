import { Icon } from '../../components/ui/Icon'
import { Button } from '../../components/ui/Button'
import { StateBadge } from '../../components/ui/StateBadge'
import type { RefObject } from 'react'

function EmptyIssueState() {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <div className="empty-art" aria-hidden="true"><div className="empty-ring ring-a" /><div className="empty-ring ring-b" /><div className="empty-card"><span /><i /><i /><i /></div><div className="empty-spark spark-a">✳</div><div className="empty-spark spark-b">·</div></div>
      <span className="empty-kicker">Issue data</span>
      <h2>Issues aren’t available yet</h2>
      <p>Your issues will appear here when issue tracking is available.</p>
      <StateBadge className="empty-state-note" tone="warning">Issue list unavailable</StateBadge>
    </div>
  )
}

function IssueDetailPane() {
  return (
    <aside className="detail-pane" aria-labelledby="detail-heading">
      <div className="detail-header"><h2 id="detail-heading">Issue details</h2><Button className="icon-button disabled-icon" size="icon" disabled aria-label="Issue detail options unavailable"><Icon name="dots" /></Button></div>
      <div className="detail-empty"><div className="detail-icon"><Icon name="inbox" /></div><h3>No issue selected</h3><p>Issue details will appear here when issue tracking is available.</p><span>No issue data available.</span></div>
      <div className="detail-footer"><span className="detail-footer-dot" />Context panel</div>
    </aside>
  )
}

export function IssueWorkspace({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
  return (
    <div className="content-layout">
      <section className="issue-workspace" aria-labelledby="page-title">
        <div className="page-heading">
          <div><div className="context-label"><span className="context-dot" />WORKSPACE VIEW</div><h1 ref={titleRef} id="page-title" tabIndex={-1}>All issues</h1><p>Your workspace issues will appear here.</p></div>
          <Button className="create-button" size="small" variant="subtle" disabled aria-label="Create issue unavailable"><Icon name="plus" /><span>Create issue</span></Button>
        </div>

        <div className="list-toolbar" aria-label="Issue list controls">
          <div className="list-tabs"><span className="list-tab active-tab" aria-current="page">List</span><span className="list-tab unavailable-tab">Board <small>Unavailable</small></span></div>
          <div className="list-actions"><Button className="toolbar-button" size="small" variant="outline" disabled><Icon name="sliders" /><span>Filter unavailable</span></Button><Button className="toolbar-button toolbar-icon" size="icon" variant="outline" disabled aria-label="More list options unavailable"><Icon name="dots" /></Button></div>
        </div>

        <div className="list-header" aria-hidden="true"><span>Issue</span><span>Status</span><span>Assignee</span><span>Priority</span></div>
        <EmptyIssueState />
        <div className="workspace-footnote"><span className="footnote-dot" />Issue tracking unavailable</div>
      </section>
      <IssueDetailPane />
    </div>
  )
}
