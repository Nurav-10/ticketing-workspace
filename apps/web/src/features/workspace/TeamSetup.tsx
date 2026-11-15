import { useState, type FormEvent } from 'react'
import { ApiRequestError, createTeam, type TeamSummary } from './workspace-api'
import './team-setup.css'

export function TeamSetup({ workspaceId, onCreated }: { workspaceId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [visibility, setVisibility] = useState<TeamSummary['visibility']>('workspace')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    if (!form.reportValidity()) return
    const fields = new FormData(form)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const team = await createTeam(workspaceId, {
        name: String(fields.get('name') ?? '').trim(),
        key: String(fields.get('key') ?? '').trim().toUpperCase(),
        visibility,
      })
      form.reset()
      setOpen(false)
      setNotice(team.visibility === 'private' ? `${team.name} created. Add members under Manage private teams before accessing its issues.` : `${team.name} created. Select it in the team menu.`)
      setVisibility('workspace')
      onCreated()
    } catch (caught) {
      setError(caught instanceof ApiRequestError && caught.status === 403
        ? 'You no longer have permission to create teams in this workspace.'
        : caught instanceof ApiRequestError && caught.status === 409
          ? 'A team with this issue key already exists. Choose another key.'
        : 'Team could not be created. Check the details and try again.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="team-setup" aria-label="Team administration">
    {!open && <button type="button" onClick={() => { setNotice(''); setOpen(true) }}>Create team</button>}
    {notice && <p role="status">{notice}</p>}
    {open && <form onSubmit={(event) => void submit(event)}>
      <h2>Create a team</h2>
      <label>Team name<input name="name" required maxLength={120} autoFocus /></label>
      <label>Issue key<input name="key" required minLength={2} maxLength={8} pattern="[A-Za-z][A-Za-z0-9]{1,7}" aria-describedby="team-key-hint" /></label>
      <small id="team-key-hint">2–8 letters or digits, starting with a letter. Used in issue keys.</small>
      <label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as TeamSummary['visibility'])}><option value="workspace">Workspace members</option><option value="private">Private team</option></select></label>
      <p>{visibility === 'private' ? 'Only added team members can access issues. Administrators do not automatically join.' : 'All workspace members can access this team.'}</p>
      {error && <p role="alert">{error}</p>}
      <div className="team-setup-actions"><button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create team'}</button><button type="button" disabled={busy} onClick={() => { setOpen(false); setError('') }}>Cancel</button></div>
    </form>}
  </section>
}
