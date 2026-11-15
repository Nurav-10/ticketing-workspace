import { useEffect, useRef, useState } from 'react'
import { Sidebar } from '../components/shell/Sidebar'
import { Topbar } from '../components/shell/Topbar'
import { IssueWorkspace } from '../features/workspace/IssueWorkspace'
import { IssueFeature } from '../features/issues/IssueFeature'
import { useWorkspaceContext } from '../features/workspace/useWorkspaceContext'
import { TeamSetup } from '../features/workspace/TeamSetup'
import { TeamAdministration } from '../features/workspace/TeamAdministration'
import { InvitationAcceptance, InvitationManager } from '../features/invitations'
import './access-actions.css'

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const access = useWorkspaceContext()
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreMenuFocusRef = useRef(false)
  const pageTitleRef = useRef<HTMLHeadingElement>(null)
  const mutationPendingRef = useRef(false)
  const invitationPendingRef = useRef(false)
  const teamAdminPendingRef = useRef(false)
  const deferredTeamRefreshRef = useRef(false)
  const deferredWorkspaceRefreshRef = useRef(false)
  const [mutationPending, setMutationPending] = useState(false)
  const [invitationPending, setInvitationPending] = useState(false)
  const [teamAdminPending, setTeamAdminPending] = useState(false)

  function setIssueMutationPending(pending: boolean) {
    mutationPendingRef.current = pending
    setMutationPending(pending)
    if (!pending && !teamAdminPendingRef.current && deferredTeamRefreshRef.current) {
      deferredTeamRefreshRef.current = false
      access.refreshTeams()
    }
    if (!pending && !invitationPendingRef.current && !teamAdminPendingRef.current && deferredWorkspaceRefreshRef.current) {
      deferredWorkspaceRefreshRef.current = false
      access.refresh()
    }
  }

  function setInvitationInProgress(pending: boolean) {
    invitationPendingRef.current = pending
    setInvitationPending(pending)
    if (!pending && !mutationPendingRef.current && !teamAdminPendingRef.current && deferredWorkspaceRefreshRef.current) {
      deferredWorkspaceRefreshRef.current = false
      access.refresh()
    }
  }

  function setTeamAdminInProgress(pending: boolean) {
    teamAdminPendingRef.current = pending
    setTeamAdminPending(pending)
    if (!pending && !mutationPendingRef.current && deferredTeamRefreshRef.current) {
      deferredTeamRefreshRef.current = false
      access.refreshTeams()
    }
    if (!pending && !mutationPendingRef.current && !invitationPendingRef.current && deferredWorkspaceRefreshRef.current) {
      deferredWorkspaceRefreshRef.current = false
      access.refresh()
    }
  }

  function refreshTeamContext() {
    if (mutationPendingRef.current || teamAdminPendingRef.current) deferredTeamRefreshRef.current = true
    else access.refreshTeams()
  }

  function changeContext(select: (id: string) => void, id: string) {
    if (mutationPendingRef.current || invitationPendingRef.current || teamAdminPendingRef.current) return
    if (location.hash.startsWith('#issue-')) history.replaceState({}, '', location.pathname + location.search)
    select(id)
  }

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
      <Sidebar open={sidebarOpen && isMobile} mobile={isMobile} onClose={closeSidebar} auth={access.auth} workspaces={access.workspaces} items={access.items} selectedWorkspaceId={access.selectedWorkspaceId} onSelectWorkspace={(id) => changeContext(access.selectWorkspace, id)} teams={access.teams} teamAccess={access.teamAccess} selectedTeamId={access.selectedTeamId} onSelectTeam={(id) => changeContext(access.selectTeam, id)} onRetryTeams={refreshTeamContext} signingOut={access.signingOut} signOutError={access.signOutError} onSignOut={() => { if (!mutationPendingRef.current && !invitationPendingRef.current && !teamAdminPendingRef.current) void access.logout() }} onRetry={() => { if (!mutationPendingRef.current && !invitationPendingRef.current && !teamAdminPendingRef.current) access.refresh() }} mutationPending={mutationPending || invitationPending || teamAdminPending} />
      <main className="main-column" inert={sidebarOpen && isMobile ? true : undefined}>
        <Topbar
          sidebarOpen={sidebarOpen}
          menuTriggerRef={menuTriggerRef}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        />
        {invitationPending && <p className="access-actions" role="status">Finish creating or hide the invitation code before changing workspace or team.</p>}
        {access.auth === 'available' && (access.workspaces === 'signed-out' || access.workspaces === 'ready') && <details className="access-actions"><summary>Have an invitation?</summary><InvitationAcceptance key={access.workspaces} authState={access.workspaces === 'ready' ? 'signed-in' : 'signed-out'} onAccepted={() => { if (mutationPendingRef.current || invitationPendingRef.current || teamAdminPendingRef.current) deferredWorkspaceRefreshRef.current = true; else access.refresh() }} /></details>}
        {access.workspace && (access.workspace.role === 'owner' || access.workspace.role === 'admin') && <details className="access-actions"><summary>Invite a teammate</summary><InvitationManager key={access.workspace.id} workspaceId={access.workspace.id} workspaceRole={access.workspace.role} onPendingChange={setInvitationInProgress} /></details>}
        {access.workspace && (access.workspace.role === 'owner' || access.workspace.role === 'admin') && <TeamSetup key={access.workspace.id} workspaceId={access.workspace.id} onCreated={refreshTeamContext} />}
        {access.workspace && (access.workspace.role === 'owner' || access.workspace.role === 'admin') && <details className="access-actions"><summary>Manage private teams</summary><TeamAdministration key={access.workspace.id} workspaceId={access.workspace.id} onMembershipChanged={refreshTeamContext} onPendingChange={setTeamAdminInProgress} /></details>}
        {access.workspaces === 'ready' && access.teamAccess === 'ready' && access.selectedTeamId
          ? <IssueFeature key={`${access.selectedWorkspaceId}:${access.selectedTeamId}`} workspaceId={access.selectedWorkspaceId} teamId={access.selectedTeamId} titleRef={pageTitleRef} onMutationPendingChange={setIssueMutationPending} />
          : access.workspaces === 'ready' && access.teamAccess === 'ready'
            ? <section className="issue-workspace"><h1 ref={pageTitleRef} tabIndex={-1}>Issues</h1><p>Select a team in the navigation to view its issues.</p></section>
            : <IssueWorkspace titleRef={pageTitleRef} />}
      </main>
    </div>
  )
}
