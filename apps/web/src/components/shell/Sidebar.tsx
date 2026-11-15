import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { StateBadge } from '../ui/StateBadge'
import type { TeamSummary, WorkspaceSummary } from '../../features/workspace/workspace-api'

function WorkspaceMark() {
  return <span className="workspace-mark" aria-hidden="true"><i /><i /><i /></span>
}

type SidebarProps = {
  open: boolean
  mobile: boolean
  onClose: () => void
  auth: 'loading' | 'available' | 'unavailable' | 'error'
  workspaces: 'loading' | 'signed-out' | 'ready' | 'error'
  items: WorkspaceSummary[]
  selectedWorkspaceId: string
  onSelectWorkspace: (id: string) => void
  teams: TeamSummary[]
  teamAccess: 'idle' | 'loading' | 'signed-out' | 'ready' | 'error'
  selectedTeamId: string
  onSelectTeam: (id: string) => void
  onRetryTeams: () => void
  signingOut: boolean
  signOutError?: string
  onSignOut: () => void
  onRetry: () => void
  mutationPending: boolean
}

export function Sidebar({ open, mobile, onClose, auth, workspaces, items, selectedWorkspaceId, onSelectWorkspace, teams, teamAccess, selectedTeamId, onSelectTeam, onRetryTeams, signingOut, signOutError, onSignOut, onRetry, mutationPending }: SidebarProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  function keepFocusInDrawer(event: ReactKeyboardEvent<HTMLElement>) {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')
    const first = focusable.item(0)
    const last = focusable.item(focusable.length - 1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  const accessLabel = workspaces === 'loading' ? 'Loading workspace access'
    : workspaces === 'ready' ? `${items.length} workspace${items.length === 1 ? '' : 's'} available`
      : workspaces === 'signed-out' ? 'Not signed in'
        : 'Workspace access unavailable'
  const workspaceName = items.find((item) => item.id === selectedWorkspaceId)?.name ?? (workspaces === 'loading' ? 'Loading workspace…' : 'Workspace')
  const accountMessage = workspaces === 'loading' ? 'Checking access…'
    : workspaces === 'ready' ? 'Signed in'
      : workspaces === 'signed-out' ? 'Not signed in'
        : 'Access unavailable'

  return (
    <aside id="workspace-navigation" className={`sidebar${open ? ' sidebar-open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-labelledby="workspace-heading" aria-label={open ? undefined : 'Workspace navigation'} aria-hidden={mobile && !open ? true : undefined} inert={mobile && !open ? true : undefined} onKeyDown={keepFocusInDrawer}>
      <div className="sidebar-top">
        <div className="workspace-switcher" aria-label={accessLabel}>
          <span className="workspace-avatar"><WorkspaceMark /></span>
          <span className="workspace-name"><b id="workspace-heading">{workspaceName}</b><small>{workspaces === 'loading' ? 'Loading…' : workspaces === 'ready' && items.length > 1 ? `${items.length} workspaces` : accessLabel}</small></span>
        </div>
        <Button ref={closeButtonRef} className="sidebar-close" size="icon" aria-label="Close workspace navigation" onClick={onClose}><Icon name="close" /></Button>
      </div>

      <div className="sidebar-content">
        <div className="sidebar-label">Workspace</div>
        <label className="context-select-label" htmlFor="workspace-context">Workspace</label>
        <select id="workspace-context" className="context-select" value={selectedWorkspaceId} onChange={(event) => onSelectWorkspace(event.target.value)} disabled={mutationPending || workspaces !== 'ready' || items.length === 0}>
          {workspaces === 'ready' && items.length === 0 ? <option value="">No workspaces available</option> : null}
          {workspaces === 'loading' ? <option value="">Loading workspaces…</option> : null}
          {workspaces === 'signed-out' ? <option value="">Sign in to select a workspace</option> : null}
          {workspaces === 'error' ? <option value="">Workspace access unavailable</option> : null}
          {items.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <nav className="primary-nav" aria-label="Workspace sections">
          <div className="nav-item nav-current" aria-current="page"><Icon name="inbox" /><span>Team issues</span></div>
          <div className="nav-item nav-disabled" aria-disabled="true"><Icon name="user" /><span>My issues</span><small>Unavailable</small></div>
          <div className="nav-item nav-disabled" aria-disabled="true"><Icon name="layers" /><span>Projects</span><small>Unavailable</small></div>
        </nav>

        <div className="sidebar-label team-label">Team</div>
        <label className="context-select-label" htmlFor="team-context">Issue scope</label>
        <select id="team-context" className="context-select" value={selectedTeamId} onChange={(event) => onSelectTeam(event.target.value)} disabled={mutationPending || teamAccess !== 'ready' || teams.length === 0}>
          {teamAccess === 'loading' ? <option value="">Loading teams…</option> : null}
          {teamAccess === 'signed-out' ? <option value="">Sign in to load teams</option> : null}
          {teamAccess === 'error' ? <option value="">Teams unavailable</option> : null}
          {teamAccess === 'ready' && teams.length === 0 ? <option value="">No teams available</option> : null}
          {teamAccess === 'ready' && teams.length > 0 ? <option value="">Select a team</option> : null}
          {teams.map((team) => <option key={team.id} value={team.id}>{team.name} ({team.key})</option>)}
        </select>
        {teamAccess === 'error' && <Button className="access-retry" size="small" variant="subtle" onClick={onRetryTeams}>Retry loading teams</Button>}

        <div className="sidebar-label views-label">Views</div>
        <div className="sidebar-empty"><span className="sidebar-empty-mark" aria-hidden="true">—</span><span>Saved views will appear<br />when workspace access is available</span></div>
      </div>

      <div className="sidebar-bottom">
        <StateBadge className="access-card" tone={workspaces === 'ready' ? 'success' : 'warning'}><span><b>{workspaces === 'ready' ? 'Workspace access ready' : accessLabel}</b><small>{workspaces === 'error' ? 'Could not load workspace data' : auth === 'loading' ? 'Checking sign-in availability' : auth === 'available' ? 'Sign-in is available' : auth === 'error' ? 'Could not check sign-in' : 'Sign-in is unavailable'}</small></span></StateBadge>
        {(workspaces === 'error' || auth === 'error') && <Button className="access-retry" size="small" variant="subtle" onClick={onRetry}>Retry loading</Button>}
        <div className="profile-row"><span className="profile-avatar" aria-hidden="true">{workspaces === 'ready' ? '✓' : '·'}</span><span className="profile-copy"><b>{accountMessage}</b><small>{workspaces === 'ready' ? `${items.length} workspace${items.length === 1 ? '' : 's'}` : auth === 'available' ? 'Continue with your account' : 'Account session unavailable'}</small></span>
          {workspaces === 'ready' && auth === 'available' ? <Button className="signout-button" size="small" variant="subtle" disabled={signingOut || mutationPending} onClick={onSignOut}>{signingOut ? 'Signing out…' : 'Sign out'}</Button> : null}
        </div>
        {workspaces === 'signed-out' && auth === 'available' && <a className="signin-link" href="/api/v1/auth/login">Sign in</a>}
        {signOutError && <p className="access-error" role="alert">{signOutError}</p>}
        {workspaces === 'error' && <p className="access-error" role="status">Workspace data is temporarily unavailable.</p>}
      </div>
    </aside>
  )
}
