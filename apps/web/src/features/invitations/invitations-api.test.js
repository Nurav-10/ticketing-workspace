import { afterEach, describe, expect, it, mock } from 'bun:test'
import { InvitationApiError, issueInvitation, redeemInvitation, revokeInvitation, searchPendingInvitations } from './invitations-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const workspaceId = 'c45870ce-e7c8-44de-8bc9-39a9ed911190'

describe('invitation API', () => {
  it('searches for a pending invitation by email in the request body and revokes by id', async () => {
    const pending = { id: '972f7d4c-e07f-4490-935e-00073450d241', email: 'guest@example.test', role: 'member', expiresAt: '2026-11-21T12:00:00.000Z' }
    const fetchMock = mock(async (_url, options) => options.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ data: [pending] }), { status: 200 }))
    globalThis.fetch = fetchMock
    expect(await searchPendingInvitations(workspaceId, pending.email)).toEqual([pending])
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/workspaces/${workspaceId}/invitations/search`)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: pending.email })
    await revokeInvitation(workspaceId, pending.id)
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/v1/workspaces/${workspaceId}/invitations/${pending.id}`)
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
  })
  it('issues a one-time invitation with a no-store same-origin request', async () => {
    const invitation = { id: '972f7d4c-e07f-4490-935e-00073450d241', email: 'guest@example.test', role: 'member', expiresAt: '2026-11-21T12:00:00.000Z', token: 'A'.repeat(43) }
    const fetchMock = mock(async () => new Response(JSON.stringify({ data: invitation }), { status: 201 }))
    globalThis.fetch = fetchMock

    expect(await issueInvitation(workspaceId, { email: invitation.email, role: 'member' })).toEqual(invitation)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/v1/workspaces/${workspaceId}/invitations`)
    expect(options.method).toBe('POST')
    expect(options.credentials).toBe('same-origin')
    expect(options.cache).toBe('no-store')
    expect(JSON.parse(options.body)).toEqual({ email: invitation.email, role: 'member' })
  })

  it('redeems by sending the token only in a same-origin no-store JSON body', async () => {
    const token = 'A'.repeat(43)
    const fetchMock = mock(async () => new Response(JSON.stringify({ data: { workspaceId, role: 'member' } }), { status: 200 }))
    globalThis.fetch = fetchMock

    expect(await redeemInvitation(token)).toEqual({ workspaceId, role: 'member' })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/invitations/redeem')
    expect(options.credentials).toBe('same-origin')
    expect(options.cache).toBe('no-store')
    expect(options.body).toBe(JSON.stringify({ token }))
  })

  it('does not expose server response text or credentials in errors', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: { code: 'invitation_unavailable', message: 'private detail' } }), { status: 404 }))
    await expect(redeemInvitation('A'.repeat(43))).rejects.toMatchObject({ status: 404, code: 'invitation_unavailable' })
    try { await redeemInvitation('A'.repeat(43)) } catch (error) {
      expect(error).toBeInstanceOf(InvitationApiError)
      expect(error.message).not.toContain('private detail')
    }
  })

  it('marks an ambiguous issue response so the UI can prevent a conflicting retry', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 503 }))
    await expect(issueInvitation(workspaceId, { email: 'guest@example.test', role: 'member' }))
      .rejects.toMatchObject({ outcomeUnknown: true })

    globalThis.fetch = mock(async () => { throw new Error('connection dropped after request') })
    await expect(issueInvitation(workspaceId, { email: 'guest@example.test', role: 'member' }))
      .rejects.toMatchObject({ outcomeUnknown: true })
  })

  it('explains a pending invitation conflict without implying the user is already a member', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: { code: 'invitation_exists', message: 'server detail' } }), { status: 409 }))
    await expect(issueInvitation(workspaceId, { email: 'guest@example.test', role: 'member' }))
      .rejects.toMatchObject({
        code: 'invitation_exists',
        message: expect.stringContaining('Search for it below'),
      })
  })

  it('explains an existing member conflict separately from a pending invitation', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: { code: 'already_a_member', message: 'server detail' } }), { status: 409 }))
    await expect(issueInvitation(workspaceId, { email: 'guest@example.test', role: 'member' }))
      .rejects.toMatchObject({
        code: 'already_a_member',
        message: 'This email already belongs to a member of this workspace, so no invitation was created.',
      })
  })

  it('keeps an administrator conflict role-neutral', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: { code: 'invitation_conflict' } }), { status: 409 }))
    await expect(issueInvitation(workspaceId, { email: 'guest@example.test', role: 'member' }))
      .rejects.toMatchObject({ message: 'This invitation could not be created. Check access or contact a workspace owner.' })
  })
})

