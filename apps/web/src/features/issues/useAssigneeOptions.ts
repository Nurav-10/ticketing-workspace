import { useCallback, useEffect, useRef, useState } from 'react'
import { listAssigneeOptions, type AssigneeOption } from './assignee-api'

export function useAssigneeOptions(workspaceId: string, teamId: string, enabled: boolean) {
  const [items, setItems] = useState<AssigneeOption[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [reloadVersion, setReloadVersion] = useState(0)
  const requestGeneration = useRef(0)

  useEffect(() => {
    const generation = ++requestGeneration.current
    setItems([])
    setNextCursor(undefined)
    setError('')
    setLoadingMore(false)
    if (!enabled) {
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    void listAssigneeOptions(workspaceId, teamId, controller.signal)
      .then((page) => {
        if (requestGeneration.current !== generation) return
        setItems(page.items)
        setNextCursor(page.nextCursor)
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted && requestGeneration.current === generation) setError(caught instanceof Error ? caught.message : 'Could not load team members.')
      })
      .finally(() => {
        if (!controller.signal.aborted && requestGeneration.current === generation) setLoading(false)
      })

    return () => controller.abort()
  }, [workspaceId, teamId, enabled, reloadVersion])

  const loadMore = useCallback(async () => {
    if (!enabled || !nextCursor || loadingMore) return
    const generation = requestGeneration.current
    setLoadingMore(true)
    setError('')
    try {
      const page = await listAssigneeOptions(workspaceId, teamId, undefined, nextCursor)
      if (requestGeneration.current !== generation) return
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))])
      setNextCursor(page.nextCursor)
    } catch (caught) {
      if (requestGeneration.current === generation) setError(caught instanceof Error ? caught.message : 'Could not load more team members.')
    } finally {
      if (requestGeneration.current === generation) setLoadingMore(false)
    }
  }, [workspaceId, teamId, enabled, nextCursor, loadingMore])

  const retry = useCallback(() => {
    requestGeneration.current += 1
    setItems([])
    setNextCursor(undefined)
    setError('')
    setReloadVersion((version) => version + 1)
  }, [])

  return { items, nextCursor, loading, loadingMore, error, loadMore, retry }
}
