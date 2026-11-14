import { useEffect, useRef, useState } from 'react'
import { Sidebar } from '../components/shell/Sidebar'
import { Topbar } from '../components/shell/Topbar'
import { IssueWorkspace } from '../features/workspace/IssueWorkspace'

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreMenuFocusRef = useRef(false)
  const pageTitleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const breakpoint = window.matchMedia('(max-width: 760px)')
    function handleBreakpoint(event: MediaQueryListEvent) {
      setIsMobile(event.matches)
      if (!event.matches) {
        const drawer = document.getElementById('workspace-navigation')
        const focusWasInDrawer = drawer?.contains(document.activeElement) ?? false
        setSidebarOpen(false)
        if (focusWasInDrawer) window.requestAnimationFrame(() => pageTitleRef.current?.focus())
      }
    }
    breakpoint.addEventListener('change', handleBreakpoint)
    return () => breakpoint.removeEventListener('change', handleBreakpoint)
  }, [])

  useEffect(() => {
    if (sidebarOpen || !restoreMenuFocusRef.current) return
    restoreMenuFocusRef.current = false
    window.requestAnimationFrame(() => menuTriggerRef.current?.focus())
  }, [sidebarOpen])

  function closeSidebar() {
    restoreMenuFocusRef.current = true
    setSidebarOpen(false)
  }

  return (
    <div className="app-shell">
      {sidebarOpen && isMobile && <div className="mobile-scrim" aria-hidden="true" onClick={closeSidebar} />}
      <Sidebar open={sidebarOpen && isMobile} mobile={isMobile} onClose={closeSidebar} />
      <main className="main-column" inert={sidebarOpen && isMobile ? true : undefined}>
        <Topbar
          sidebarOpen={sidebarOpen}
          menuTriggerRef={menuTriggerRef}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        />
        <IssueWorkspace titleRef={pageTitleRef} />
      </main>
    </div>
  )
}
