import { useEffect, useRef, useState } from 'react'
import { listPrivateTeamMembers, listPrivateTeams, setPrivateTeamMember, type TeamMember } from './team-admin-api'
import type { TeamSummary } from './workspace-api'
import './team-setup.css'

export function TeamAdministration({ workspaceId, onMembershipChanged, onPendingChange }: { workspaceId: string; onMembershipChanged: () => void; onPendingChange: (pending: boolean) => void }) {
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [teamCursor, setTeamCursor] = useState<string | null>(null)
  const [teamId, setTeamId] = useState('')
  const [members, setMembers] = useState<TeamMember[]>([])
  const [memberCursor, setMemberCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const savingRef = useRef(false)
  const pendingCallbackRef = useRef(onPendingChange)
  pendingCallbackRef.current = onPendingChange

  useEffect(() => () => { generation.current += 1; if (savingRef.current) pendingCallbackRef.current(false) }, [])

  async function loadTeams(cursor?: string) {
    const requestId = ++generation.current
    setLoading(true); setError('')
    try {
      const page = await listPrivateTeams(workspaceId, cursor)
      if (requestId !== generation.current) return
      setTeams((current) => cursor ? [...current, ...page.data.filter((team) => !current.some((item) => item.id === team.id))] : page.data)
      setTeamCursor(page.pageInfo.nextCursor)
    } catch (caught) { if (requestId === generation.current) setError(caught instanceof Error ? caught.message : 'Could not load teams.') }
    finally { if (requestId === generation.current) setLoading(false) }
  }

  async function loadMembers(id: string, cursor?: string) {
    const requestId = ++generation.current
    setLoading(true); setError('')
    try {
      const page = await listPrivateTeamMembers(workspaceId, id, cursor)
      if (requestId !== generation.current) return
      setMembers((current) => cursor ? [...current, ...page.data.filter((member) => !current.some((item) => item.id === member.id))] : page.data)
      setMemberCursor(page.pageInfo.nextCursor)
    } catch (caught) { if (requestId === generation.current) setError(caught instanceof Error ? caught.message : 'Could not load members.') }
    finally { if (requestId === generation.current) setLoading(false) }
  }

  async function changeMembership(member: TeamMember) {
    if (savingRef.current || !teamId || !confirm(`${member.isTeamMember ? 'Remove' : 'Add'} ${member.displayName} ${member.isTeamMember ? 'from' : 'to'} this private team?`)) return
    savingRef.current = true; pendingCallbackRef.current(true); setSaving(true); setError(''); setNotice('')
    try {
      await setPrivateTeamMember(workspaceId, teamId, member.id, !member.isTeamMember)
      setMembers((current) => current.map((item) => item.id === member.id ? { ...item, isTeamMember: !member.isTeamMember } : item))
      setNotice(`Team membership updated for ${member.displayName}.`)
      onMembershipChanged()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not change membership.') }
    finally { savingRef.current = false; setSaving(false); pendingCallbackRef.current(false) }
  }

  return <section className="team-admin" aria-labelledby="private-team-admin-title">
    <h2 id="private-team-admin-title">Private teams</h2>
    <p>Workspace owners and administrators can manage membership. Team content remains limited to members.</p>
    <button type="button" disabled={loading || saving} onClick={() => { setTeamId(''); setMembers([]); void loadTeams() }}>Load private teams</button>
    {teams.length > 0 && <label>Team<select value={teamId} disabled={loading || saving} onChange={(event) => { const id = event.target.value; setTeamId(id); setMembers([]); setMemberCursor(null); setNotice(''); if (id) void loadMembers(id) }}><option value="">Select a private team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} ({team.key})</option>)}</select></label>}
    {teamCursor && <button type="button" disabled={loading || saving} onClick={() => void loadTeams(teamCursor)}>Load more teams</button>}
    {teamId && <><h3>Workspace members</h3>{members.length > 0 ? <ul>{members.map((member) => <li key={member.id}><span>{member.displayName} · {member.email} · {member.role} {member.isTeamMember ? '· Team member' : ''}</span><button type="button" disabled={loading || saving} onClick={() => void changeMembership(member)}>{member.isTeamMember ? 'Remove' : 'Add'}</button></li>)}</ul> : !loading && <p>No members on this page.</p>}{memberCursor && <button type="button" disabled={loading || saving} onClick={() => void loadMembers(teamId, memberCursor)}>Load more members</button>}</>}
    {loading && <p role="status">Loading…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
