import { useEffect, useRef, useState, type FormEvent } from 'react'
import './saved-views.css'
import {
  createSavedView, deleteSavedView, getSavedView, listSavedViews, SavedViewApiError, updateSavedView,
  type SavedView, type SavedViewScope, type ViewVisibility,
} from './views-api'

type ConflictIntent = { id: string; kind: 'rename' | 'visibility' | 'delete'; latestLoaded: boolean }

function visibilityLabel(visibility: ViewVisibility) {
  return visibility === 'team' ? 'Team' : 'Personal'
}

/**
 * Route-independent saved-view catalog. The parent can use onOpen to apply a view
 * through the authorized issue query path; this component never writes filter data to a URL.
 */
export function SavedViews(props: SavedViewScope & { onOpen?: (view: SavedView) => void }) {
  // A team change gets a fresh state container. In-flight writes or pagination
  // from the previous team cannot populate the newly selected team's catalog.
  return <SavedViewsCatalog key={JSON.stringify([props.workspaceId, props.teamId])} {...props} />
}

function SavedViewsCatalog({
  workspaceId,
  teamId,
  onOpen,
}: SavedViewScope & { onOpen?: (view: SavedView) => void }) {
  const scope = { workspaceId, teamId }
  const [views, setViews] = useState<SavedView[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<ViewVisibility>('private')
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null)
  const [visibilityDrafts, setVisibilityDrafts] = useState<Record<string, ViewVisibility>>({})
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictIntent | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<HTMLInputElement>(null)

  async function loadFirst(signal?: AbortSignal) {
    setLoading(true)
    setError('')
    try {
      const page = await listSavedViews(scope, { signal })
      if (signal?.aborted) return
      setViews(page.items)
      setCursor(page.nextCursor)
      setConflict(null)
    } catch (caught) {
      if (!signal?.aborted && !(caught instanceof SavedViewApiError && caught.code === 'aborted')) {
        setError(caught instanceof Error ? caught.message : 'Could not load saved views.')
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    setViews([])
    setCursor(undefined)
    setError('')
    setNotice('')
    setEdit(null)
    setConflict(null)
    void loadFirst(controller.signal)
    return () => controller.abort()
    // Scope changes replace the catalog and cancel the previous request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, teamId])

  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => { editRef.current?.focus() }, [edit?.id])

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const page = await listSavedViews(scope, { cursor })
      setViews((current) => {
        const next = [...current]
        for (const item of page.items) {
          const index = next.findIndex((existing) => existing.id === item.id)
          if (index < 0) next.push(item)
          else next[index] = item
        }
        return next
      })
      setCursor(page.nextCursor)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load more saved views.')
    } finally {
      setLoadingMore(false)
    }
  }

  function replaceView(updated: SavedView) {
    setViews((current) => current.map((item) => item.id === updated.id ? updated : item))
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusyId('create')
    setError('')
    setNotice('')
    try {
      const created = await createSavedView(scope, { name: trimmed, visibility })
      setName('')
      setViews((current) => [created, ...current.filter((item) => item.id !== created.id)])
      setNotice(`Created “${created.name}”.`)
      setConflict(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the saved view.')
    } finally {
      setBusyId(null)
    }
  }

  function startRename(view: SavedView) {
    setEdit({ id: view.id, name: view.name })
    setError('')
    setNotice('')
  }

  async function saveRename(view: SavedView, requestedName = edit?.name ?? '') {
    const nextName = requestedName.trim()
    if (!nextName) {
      setError('Enter a name before saving.')
      editRef.current?.focus()
      return
    }
    setBusyId(view.id)
    setError('')
    setNotice('')
    try {
      const updated = await updateSavedView(scope, view, { name: nextName })
      replaceView(updated)
      setEdit(null)
      setConflict(null)
      setNotice('Saved view renamed.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rename the saved view.')
      if (caught instanceof SavedViewApiError && caught.isConflict) setConflict({ id: view.id, kind: 'rename', latestLoaded: false })
    } finally {
      setBusyId(null)
    }
  }

  async function saveVisibility(view: SavedView) {
    const nextVisibility = visibilityDrafts[view.id] ?? view.visibility
    if (nextVisibility === view.visibility) return
    setBusyId(view.id)
    setError('')
    setNotice('')
    try {
      const updated = await updateSavedView(scope, view, { visibility: nextVisibility })
      replaceView(updated)
      setVisibilityDrafts((current) => { const next = { ...current }; delete next[view.id]; return next })
      setConflict(null)
      setNotice(`Visibility changed to ${visibilityLabel(updated.visibility).toLowerCase()}.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change saved-view visibility.')
      if (caught instanceof SavedViewApiError && caught.isConflict) setConflict({ id: view.id, kind: 'visibility', latestLoaded: false })
    } finally {
      setBusyId(null)
    }
  }

  async function remove(view: SavedView) {
    setBusyId(view.id)
    setError('')
    setNotice('')
    try {
      await deleteSavedView(scope, view)
      setViews((current) => current.filter((item) => item.id !== view.id))
      setConfirmDeleteId(null)
      setConflict(null)
      setNotice(`Deleted “${view.name}”.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the saved view.')
      if (caught instanceof SavedViewApiError && caught.isConflict) setConflict({ id: view.id, kind: 'delete', latestLoaded: false })
    } finally {
      setBusyId(null)
    }
  }

  async function reloadConflict() {
    if (!conflict) return
    setBusyId(conflict.id)
    setError('')
    try {
      const latest = await getSavedView(scope, conflict.id)
      replaceView(latest)
      setConflict({ ...conflict, latestLoaded: true })
      setNotice('Latest saved-view version loaded. Review your change before retrying.')
    } catch (caught) {
      if (caught instanceof SavedViewApiError && caught.status === 404) {
        setViews((current) => current.filter((item) => item.id !== conflict.id))
        setConflict(null)
      }
      setError(caught instanceof Error ? caught.message : 'Could not load the latest saved-view version.')
    } finally {
      setBusyId(null)
    }
  }

  async function retryConflict() {
    if (!conflict?.latestLoaded) return
    const latest = views.find((item) => item.id === conflict.id)
    if (!latest) return
    if (conflict.kind === 'rename') await saveRename(latest)
    else if (conflict.kind === 'visibility') await saveVisibility(latest)
    else await remove(latest)
  }

  const conflictItem = conflict ? views.find((item) => item.id === conflict.id) : undefined

  return <section className="saved-views" aria-labelledby="saved-views-title">
    <header className="saved-views__heading">
      <div>
        <p className="saved-views__eyebrow">TEAM WORKSPACE</p>
        <h1 id="saved-views-title" tabIndex={-1}>Saved views</h1>
        <p>Keep a named list or board setup for personal use or the whole team.</p>
      </div>
      <button className="saved-views__refresh" type="button" onClick={() => void loadFirst()} disabled={loading || busyId !== null}>
        Refresh
      </button>
    </header>

    {notice && <p className="saved-views__notice" role="status">{notice}</p>}
    {error && <div className="saved-views__error" role="alert">{error}</div>}

    {conflict && conflictItem && <div className="saved-views__conflict" role="group" aria-label="Resolve saved-view conflict">
      <p><strong>This view changed while you were editing it.</strong> Load the latest version, then decide whether to reapply your change.</p>
      <div className="saved-views__actions">
        <button type="button" className="saved-views__button--secondary" disabled={busyId !== null} onClick={() => void reloadConflict()}>
          Load latest version
        </button>
        <button type="button" disabled={busyId !== null || !conflict.latestLoaded} onClick={() => void retryConflict()}>
          {conflict.kind === 'delete' ? 'Retry delete' : 'Reapply my change'}
        </button>
        <button type="button" className="saved-views__text-button" disabled={busyId !== null} onClick={() => setConflict(null)}>Dismiss</button>
      </div>
    </div>}

    <form className="saved-views__create" onSubmit={(event) => void create(event)}>
      <div className="saved-views__create-copy">
        <h2>Create a view</h2>
        <p>New views start with the API’s default filters. Set filters in the issue workspace after creation.</p>
      </div>
      <label className="saved-views__field">
        <span>Name</span>
        <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required aria-describedby="saved-view-name-help" />
        <small id="saved-view-name-help">Up to 100 characters.</small>
      </label>
      <label className="saved-views__field saved-views__visibility-field">
        <span>Visibility</span>
        <select value={visibility} onChange={(event) => setVisibility(event.target.value as ViewVisibility)}>
          <option value="private">Personal</option>
          <option value="team">Team</option>
        </select>
      </label>
      <button type="submit" disabled={!name.trim() || busyId !== null}>{busyId === 'create' ? 'Creating…' : 'Create view'}</button>
    </form>

    <div className="saved-views__list-heading">
      <div><h2>Views for this team</h2><p>Personal views are visible to you. Team views follow the team’s access rules.</p></div>
      <span aria-live="polite">{loading ? 'Loading' : `${views.length}${cursor ? '+' : ''} views`}</span>
    </div>

    {loading ? <div className="saved-views__loading" role="status" aria-label="Loading saved views"><span /> <span /> <span /></div>
      : views.length === 0 ? <p className="saved-views__empty">No saved views yet. Create one to keep a useful issue setup close at hand.</p>
        : <ul className="saved-views__list">
          {views.map((view) => {
            const rowBusy = busyId === view.id
            const selectedVisibility = visibilityDrafts[view.id] ?? view.visibility
            const isEditing = edit?.id === view.id
            return <li className="saved-views__row" key={view.id}>
              <div className="saved-views__view-main">
                {isEditing ? <form className="saved-views__rename" onSubmit={(event) => { event.preventDefault(); void saveRename(view) }}>
                  <label>
                    <span className="saved-views__sr-only">Rename {view.name}</span>
                    <input ref={editRef} value={edit.name} maxLength={100} required disabled={rowBusy} onChange={(event) => setEdit({ id: view.id, name: event.target.value })}
                      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setEdit(null) } }} />
                  </label>
                  <button type="submit" disabled={rowBusy || !edit.name.trim()}>{rowBusy ? 'Saving…' : 'Save name'}</button>
                  <button type="button" className="saved-views__button--secondary" disabled={rowBusy} onClick={() => setEdit(null)}>Cancel</button>
                </form> : <>
                  <div className="saved-views__title-line">
                    {onOpen ? <button className="saved-views__open" type="button" disabled={rowBusy} onClick={() => onOpen(view)}>{view.name}</button> : <h3>{view.name}</h3>}
                    <span className={`saved-views__badge saved-views__badge--${view.visibility}`}>{visibilityLabel(view.visibility)}</span>
                  </div>
                  <p>Updated <time dateTime={view.updatedAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(view.updatedAt))}</time></p>
                </>}
              </div>
              {!isEditing && <div className="saved-views__row-actions">
                <button type="button" className="saved-views__button--secondary" aria-label={`Rename ${view.name}`} disabled={rowBusy || busyId !== null} onClick={() => startRename(view)}>Rename</button>
                <label className="saved-views__row-visibility">
                  <span className="saved-views__sr-only">Visibility for {view.name}</span>
                  <select value={selectedVisibility} disabled={rowBusy || busyId !== null} onChange={(event) => setVisibilityDrafts((current) => ({ ...current, [view.id]: event.target.value as ViewVisibility }))}>
                    <option value="private">Personal</option><option value="team">Team</option>
                  </select>
                </label>
                <button type="button" className="saved-views__button--secondary" aria-label={`Save visibility for ${view.name}`} disabled={rowBusy || busyId !== null || selectedVisibility === view.visibility} onClick={() => void saveVisibility(view)}>
                  {rowBusy ? 'Saving…' : 'Save access'}
                </button>
                {confirmDeleteId === view.id ? <span className="saved-views__delete-confirm">
                  <span>Delete this view?</span>
                  <button type="button" className="saved-views__danger" disabled={rowBusy || busyId !== null} onClick={() => void remove(view)}>{rowBusy ? 'Deleting…' : 'Confirm delete'}</button>
                  <button type="button" className="saved-views__text-button" disabled={rowBusy} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                </span> : <button type="button" className="saved-views__button--secondary" aria-label={`Delete ${view.name}`} disabled={rowBusy || busyId !== null} onClick={() => setConfirmDeleteId(view.id)}>Delete</button>}
              </div>}
            </li>
          })}
        </ul>}

    {cursor && !loading && <div className="saved-views__more">
      <button type="button" className="saved-views__button--secondary" disabled={loadingMore || busyId !== null} onClick={() => void loadMore()}>
        {loadingMore ? 'Loading more…' : 'Load more views'}
      </button>
    </div>}
    <p className="saved-views__paging-note">The catalog is a live, update-time traversal. Refresh if concurrent edits move a view between pages.</p>
  </section>
}
