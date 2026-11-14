import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../ui/Icon'

function WorkspaceMark() {
  return <span className="workspace-mark" aria-hidden="true"><i /><i /><i /></span>
}

type SidebarProps = { open: boolean; mobile: boolean; onClose: () => void }

export function Sidebar({ open, mobile, onClose }: SidebarProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) closeButtonRef.current?.focus()
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

  return (
    <aside id="workspace-navigation" className={`sidebar${open ? ' sidebar-open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-labelledby="workspace-heading" aria-label={open ? undefined : 'Workspace navigation'} aria-hidden={mobile && !open ? true : undefined} inert={mobile && !open ? true : undefined} onKeyDown={keepFocusInDrawer}>
      <div className="sidebar-top">
        <div className="workspace-switcher" aria-label="Workspace access is unavailable">
          <span className="workspace-avatar"><WorkspaceMark /></span>
          <span className="workspace-name"><b id="workspace-heading">Workspace</b><small>Sign-in unavailable</small></span>
          <span className="switcher-chevron"><Icon name="chevron" /></span>
        </div>
        <button ref={closeButtonRef} className="sidebar-close" aria-label="Close workspace navigation" onClick={onClose}><Icon name="close" /></button>
      </div>

      <div className="sidebar-content">
        <div className="sidebar-label">Workspace</div>
        <nav className="primary-nav" aria-label="Workspace sections">
          <div className="nav-item nav-current" aria-current="page"><Icon name="inbox" /><span>All issues</span></div>
          <div className="nav-item nav-disabled" aria-disabled="true"><Icon name="user" /><span>My issues</span><small>Unavailable</small></div>
          <div className="nav-item nav-disabled" aria-disabled="true"><Icon name="layers" /><span>Projects</span><small>Unavailable</small></div>
        </nav>

        <div className="sidebar-label team-label">Teams</div>
        <div className="team-row"><span className="team-glyph">·</span><span>Team access unavailable</span></div>

        <div className="sidebar-label views-label">Views</div>
        <div className="sidebar-empty"><span className="sidebar-empty-mark" aria-hidden="true">—</span><span>Saved views will appear<br />when workspace access is available</span></div>
      </div>

      <div className="sidebar-bottom">
        <div className="access-card"><span className="access-card-dot" /><span><b>Workspace access unavailable</b><small>Sign-in is unavailable</small></span></div>
        <div className="profile-row"><span className="profile-avatar" aria-hidden="true">·</span><span className="profile-copy"><b>Not signed in</b><small>Sign-in is unavailable</small></span><button className="icon-button disabled-icon" aria-label="Account options unavailable" disabled><Icon name="dots" /></button></div>
      </div>
    </aside>
  )
}
