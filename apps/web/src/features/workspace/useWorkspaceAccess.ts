import { useCallback, useEffect, useState } from 'react'
import { ApiRequestError, getAuthAvailability, getWorkspaces, signOut, type WorkspaceSummary } from './workspace-api'

type AccessState = {
  auth: 'loading' | 'available' | 'unavailable' | 'error'
  workspaces: 'loading' | 'signed-out' | 'ready' | 'error'
  items: WorkspaceSummary[]
  error?: string
  signingOut: boolean
  signOutError?: string
}

const initialState: AccessState = { auth: 'loading', workspaces: 'loading', items: [], signingOut: false }

export function useWorkspaceAccess() {
  const [state, setState] = useState(initialState)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    setState(initialState)
    async function load() {
      const [authResult, workspaceResult] = await Promise.allSettled([getAuthAvailability(), getWorkspaces()])
      if (!active) return
      const auth = authResult.status === 'rejected' ? 'error' : authResult.value ? 'available' : 'unavailable'
      if (workspaceResult.status === 'fulfilled') {
        setState({ auth, workspaces: 'ready', items: workspaceResult.value, signingOut: false })
      } else if (workspaceResult.reason instanceof ApiRequestError && workspaceResult.reason.status === 401) {
        setState({ auth, workspaces: 'signed-out', items: [], signingOut: false })
      } else {
        setState({ auth, workspaces: 'error', items: [], error: 'Workspace information could not be loaded.', signingOut: false })
      }
    }
    void load()
    return () => { active = false }
  }, [reloadKey])

  const refresh = useCallback(() => setReloadKey((key) => key + 1), [])
  const logout = useCallback(async () => {
    setState((current) => ({ ...current, signingOut: true, signOutError: undefined }))
    try {
      await signOut()
      refresh()
    } catch {
      setState((current) => ({ ...current, signingOut: false, signOutError: 'Sign-out failed. Please try again.' }))
    }
  }, [refresh])

  return { ...state, refresh, logout }
}
