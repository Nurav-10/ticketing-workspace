import { useState } from 'react'
import { InvitationApiError, redeemInvitation, type InvitationMembership } from './invitations-api'
import './invitations.css'

const tokenPattern = '[A-Za-z0-9_-]{43}'
const canonicalToken = /^[A-Za-z0-9_-]{43}$/

export function InvitationAcceptance({ onAccepted, authState }: { onAccepted?: (membership: InvitationMembership) => void; authState?: 'signed-in' | 'signed-out' }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [signInRequired, setSignInRequired] = useState(authState !== 'signed-in')
  const [signingIn, setSigningIn] = useState(false)
  const [accepted, setAccepted] = useState<InvitationMembership | null>(null)

  async function acceptWhileSignedIn() {
    setBusy(true)
    setError('')
    try {
      const membership = await redeemInvitation(token.trim())
      setAccepted(membership)
      setToken('')
      onAccepted?.(membership)
    } catch (caught) {
      if (caught instanceof InvitationApiError && caught.status === 401) setSignInRequired(true)
      setError(caught instanceof InvitationApiError ? caught.message : 'The invitation could not be accepted.')
    } finally {
      setBusy(false)
    }
  }

  if (accepted) return <section className="invitation-panel" aria-labelledby="invitation-accepted-title">
    <span className="invitation-panel__eyebrow">Workspace access</span>
    <h2 id="invitation-accepted-title">You’re in</h2>
    <p className="invitation-message" role="status">Invitation accepted. Your workspace role is {accepted.role}.</p>
  </section>

  return <section className="invitation-panel" aria-labelledby="invitation-acceptance-title">
    <div className="invitation-panel__heading">
      <span className="invitation-panel__eyebrow">Workspace access</span>
      <h2 id="invitation-acceptance-title">Accept an invitation</h2>
      <p>Enter the one-time code you received. You must sign in with its verified email address.</p>
    </div>
    <form className="invitation-form" method="post" action="/api/v1/auth/login" encType="application/x-www-form-urlencoded" onSubmit={(event) => {
      if (!signInRequired || signingIn) event.preventDefault()
      else { setError(''); setSigningIn(true) }
    }}>
      <label htmlFor="invitation-token">Invitation code</label>
      <input
        id="invitation-token"
        name="invitationToken"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        required
        pattern={tokenPattern}
        minLength={43}
        maxLength={43}
        value={token}
        onChange={(event) => setToken(event.target.value.trim())}
        aria-describedby="invitation-token-help"
      />
      <small id="invitation-token-help">The code is sent in the sign-in form body and never added to the address bar.</small>
      {error && <p className="invitation-message invitation-message--error" role="alert">{error}</p>}
      <div className="invitation-actions">
        {!signInRequired && <button className="invitation-button invitation-button--primary" type="button" disabled={busy || !canonicalToken.test(token)} onClick={() => void acceptWhileSignedIn()}>
          {busy ? 'Accepting…' : 'Accept invitation'}
        </button>}
        {signInRequired && <button className="invitation-button invitation-button--primary" type="submit" disabled={!canonicalToken.test(token) || signingIn}>
          {signingIn ? 'Signing in…' : 'Sign in to accept'}
        </button>}
      </div>
    </form>
  </section>
}
