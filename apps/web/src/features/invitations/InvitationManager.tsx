import { useEffect, useRef, useState, type FormEvent } from 'react'
import { InvitationApiError, issueInvitation, revokeInvitation, searchPendingInvitations, type IssuedInvitation, type InvitationRole, type PendingInvitation } from './invitations-api'
import './invitations.css'

type WorkspaceRole = 'owner' | 'admin' | 'member'

function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function InvitationManager({ workspaceId, workspaceRole, onPendingChange }: {
  workspaceId: string
  workspaceRole: WorkspaceRole
  onPendingChange?: (pending: boolean) => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InvitationRole>('member')
  const [issued, setIssued] = useState<IssuedInvitation | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lookupEmail, setLookupEmail] = useState('')
  const [matches, setMatches] = useState<PendingInvitation[] | null>(null)
  const [recoveryError, setRecoveryError] = useState('')
  const inFlightRef = useRef(false)
  const callbackRef = useRef(onPendingChange)
  const protectedRef = useRef(false)
  callbackRef.current = onPendingChange
  const canInvite = workspaceRole === 'owner' || workspaceRole === 'admin'

  function setCodeProtected(protectedCode: boolean) {
    if (protectedRef.current === protectedCode) return
    protectedRef.current = protectedCode
    callbackRef.current?.(protectedCode)
  }

  useEffect(() => () => {
    if (protectedRef.current) {
      protectedRef.current = false
      callbackRef.current?.(false)
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canInvite || issued || uncertain || inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setCodeProtected(true)
    setError('')
    setNotice('')
    try {
      const invitation = await issueInvitation(workspaceId, { email: email.trim(), role })
      setIssued(invitation)
      setEmail('')
    } catch (caught) {
      setCodeProtected(false)
      if (caught instanceof InvitationApiError && caught.outcomeUnknown) {
        setUncertain(true)
        setLookupEmail(email.trim())
        setError('The invitation may have been created, but its code was not received. Search for the pending invitation below and revoke it before issuing another code.')
      } else {
        if (caught instanceof InvitationApiError && (caught.code === 'invitation_exists' || caught.code === 'invitation_conflict')) setLookupEmail(email.trim())
        setError(caught instanceof InvitationApiError ? caught.message : 'The invitation could not be created.')
      }
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }

  async function findPending(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlightRef.current || issued) return
    inFlightRef.current = true
    setBusy(true)
    setCodeProtected(true)
    setRecoveryError('')
    setMatches(null)
    try { setMatches(await searchPendingInvitations(workspaceId, lookupEmail.trim())) }
    catch (caught) { setRecoveryError(caught instanceof InvitationApiError ? caught.message : 'Could not find invitations.') }
    finally { inFlightRef.current = false; setBusy(false); setCodeProtected(false) }
  }

  async function revokePending(invitation: PendingInvitation) {
    if (inFlightRef.current || issued || !confirm(`Revoke the pending invitation for ${invitation.email}?`)) return
    inFlightRef.current = true
    setBusy(true)
    setCodeProtected(true)
    setRecoveryError('')
    try {
      await revokeInvitation(workspaceId, invitation.id)
      setMatches((current) => current?.filter((item) => item.id !== invitation.id) ?? null)
      if (lookupEmail.trim().toLowerCase() === email.trim().toLowerCase()) { setUncertain(false); setError('') }
      setNotice('Invitation revoked. You can issue a new code.')
    } catch (caught) { setRecoveryError(caught instanceof InvitationApiError ? caught.message : 'Could not revoke the invitation.') }
    finally { inFlightRef.current = false; setBusy(false); setCodeProtected(false) }
  }

  async function copyToken() {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.token)
      setNotice('Invitation code copied. Share it with the invited person through your approved channel.')
    } catch {
      setNotice('Copy is unavailable here. Select the invitation code and copy it manually.')
    }
  }

  return <section className="invitation-panel" aria-labelledby="invitation-manager-title">
    <div className="invitation-panel__heading">
      <span className="invitation-panel__eyebrow">Workspace access</span>
      <h2 id="invitation-manager-title">Invite a teammate</h2>
      <p>Create a one-time invitation for a verified email address.</p>
    </div>
    {canInvite ? <form className="invitation-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor="invite-email">Email address</label>
      <input id="invite-email" type="email" autoComplete="email" required maxLength={320} value={email} disabled={busy || Boolean(issued) || uncertain} onChange={(event) => setEmail(event.target.value)} />
      <label htmlFor="invite-role">Workspace role</label>
      <select id="invite-role" value={role} disabled={busy || Boolean(issued) || uncertain} onChange={(event) => setRole(event.target.value as InvitationRole)}>
        <option value="member">Member</option>
        {workspaceRole === 'owner' && <option value="admin">Administrator</option>}
      </select>
      {!issued && !uncertain && <button className="invitation-button invitation-button--primary" type="submit" disabled={busy || !workspaceId}>
        {busy ? 'Creating invitation…' : 'Create invitation'}
      </button>}
    </form> : <p className="invitation-message">Only workspace owners and administrators can issue invitations.</p>}
    {error && <p className="invitation-message invitation-message--error" role="alert">{error}</p>}
    {notice && <p className="invitation-message" role="status">{notice}</p>}
    {issued && <div className="invitation-issued" aria-labelledby="invitation-issued-title">
      <div>
        <h3 id="invitation-issued-title">Invitation ready</h3>
        <p>Send this one-time code to <strong>{issued.email}</strong>. It expires {formatExpiry(issued.expiresAt)}.</p>
      </div>
      <label htmlFor="issued-invitation-code">Invitation code</label>
      <div className="invitation-code-row">
        <input id="issued-invitation-code" className="invitation-code" type="text" readOnly value={issued.token} spellCheck={false} autoComplete="off" aria-describedby="invitation-code-help" />
        <button className="invitation-button" type="button" onClick={() => void copyToken()}>Copy code</button>
      </div>
      <small id="invitation-code-help">This secret is shown only now. The recipient enters it on the invitation acceptance screen.</small>
      <button className="invitation-dismiss" type="button" onClick={() => { setIssued(null); setNotice(''); setCodeProtected(false) }}>Hide code and invite another person</button>
    </div>}
    {!issued && canInvite && <section aria-labelledby="invitation-recovery-title">
      <h3 id="invitation-recovery-title">Find a pending invitation</h3>
      <p>Search by the invited email. Revoking an invitation makes its existing code unusable.</p>
      <form className="invitation-form" onSubmit={(event) => void findPending(event)}>
        <label htmlFor="pending-invitation-email">Invited email address</label>
        <input id="pending-invitation-email" type="email" required maxLength={320} value={lookupEmail} disabled={busy} onChange={(event) => { setLookupEmail(event.target.value); setMatches(null) }} />
        <button className="invitation-button" type="submit" disabled={busy}>{busy ? 'Working…' : 'Find invitation'}</button>
      </form>
      {recoveryError && <p role="alert">{recoveryError}</p>}
      {matches && (matches.length === 0 ? <p role="status">No manageable pending invitation found. If a request just failed, wait and search again before retrying. Only owners can manage administrator invitations.</p> : <ul>{matches.map((invitation) => <li key={invitation.id}>{invitation.email} · {invitation.role} · expires {formatExpiry(invitation.expiresAt)} <button className="invitation-button" type="button" disabled={busy || (workspaceRole !== 'owner' && invitation.role === 'admin')} onClick={() => void revokePending(invitation)}>Revoke invitation</button></li>)}</ul>)}
    </section>}
  </section>
}
