import { useCallback, useEffect, useState } from 'react'
import { ApiRequestError, getTeams, type TeamSummary } from './workspace-api'
import { useWorkspaceAccess } from './useWorkspaceAccess'

type TeamAccess = 'idle' | 'loading' | 'signed-out' | 'ready' | 'error'

export function useWorkspaceContext() {
  const access = useWorkspaceAccess()
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [teamAccess, setTeamAccess] = useState<TeamAccess>('idle')
  const [teamReloadKey, setTeamReloadKey] = useState(0)

  const workspace = access.items.find((item) => item.id === selectedWorkspaceId) ?? access.items[0]

  useEffect(() => {
    if (access.workspaces !== 'ready') {
      setSelectedWorkspaceId('')
      setSelectedTeamId('')
      setTeams([])
      setTeamAccess(access.workspaces === 'signed-out' ? 'signed-out' : 'idle')
      return
    }
    if (!access.items.some((item) => item.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(access.items[0]?.id ?? '')
      setSelectedTeamId('')
    }
  }, [access.items, access.workspaces, selectedWorkspaceId])

  useEffect(() => {
    if (!workspace || access.workspaces !== 'ready') return
    let active = true
    setTeams([])
    setTeamAccess('loading')
    void getTeams(workspace.id).then((result) => {
      if (!active) return
      setTeams(result)
      setSelectedTeamId((current) => result.some((team) => team.id === current) ? current : '')
      setTeamAccess('ready')
    }).catch((error: unknown) => {
      if (!active) return
      setTeams([])
      setTeamAccess(error instanceof ApiRequestError && error.status === 401 ? 'signed-out' : 'error')
    })
    return () => { active = false }
  }, [access.workspaces, workspace?.id, teamReloadKey])

  const selectWorkspace = useCallback((id: string) => {
    setSelectedWorkspaceId(id)
    setSelectedTeamId('')
  }, [])
  const selectTeam = useCallback((id: string) => setSelectedTeamId(id), [])
  const refreshTeams = useCallback(() => setTeamReloadKey((key) => key + 1), [])

  return { ...access, workspace, selectedWorkspaceId: workspace?.id ?? '', selectWorkspace, teams, teamAccess, selectedTeamId, selectTeam, refreshTeams }
}
