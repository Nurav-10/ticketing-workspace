import type { RefObject } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'

type TopbarProps = {
  sidebarOpen: boolean
  menuTriggerRef: RefObject<HTMLButtonElement | null>
  onToggleSidebar: () => void
}

export function Topbar({ sidebarOpen, menuTriggerRef, onToggleSidebar }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <Button ref={menuTriggerRef} className="mobile-menu-button" size="icon" aria-label={sidebarOpen ? 'Close workspace navigation' : 'Open workspace navigation'} aria-expanded={sidebarOpen} aria-controls="workspace-navigation" onClick={onToggleSidebar}><Icon name="menu" /></Button>
        <div className="breadcrumb"><span>Workspace</span><b>/</b><strong>All issues</strong></div>
      </div>
      <div className="topbar-actions">
        <Button className="search-control" variant="subtle" disabled aria-label="Search is unavailable"><Icon name="search" /><span>Search unavailable</span></Button>
        <Button className="top-icon disabled-icon" size="icon" variant="outline" disabled aria-label="Create issue unavailable"><Icon name="plus" /></Button>
      </div>
    </header>
  )
}
