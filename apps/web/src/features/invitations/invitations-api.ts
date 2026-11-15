export type InvitationRole = 'admin' | 'member'
export interface IssuedInvitation {
  id: string
  email: string
  role: InvitationRole
  expiresAt: string
  token: string
}
export interface InvitationMembership { workspaceId: string; role: InvitationRole }
export interface IssueInvitationInput { email: string; role: InvitationRole }
export interface PendingInvitation { id: string; email: string; role: InvitationRole; expiresAt: string }

type Envelope<T> = { data: T }
type ErrorBody = { error?: { code?: string } }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const opaqueToken = /^[A-Za-z0-9_-]{43}$/

export class InvitationApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly outcomeUnknown = false) {
    super(message)
    this.name = 'InvitationApiError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invitationRole(value: unknown): value is InvitationRole {
  return value === 'admin' || value === 'member'
}

function decodeIssuedInvitation(value: unknown): IssuedInvitation {
  if (!record(value) || typeof value.id !== 'string' || !uuid.test(value.id) ||
      typeof value.email !== 'string' || !value.email.trim() || !invitationRole(value.role) ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      typeof value.token !== 'string' || !opaqueToken.test(value.token)) {
    throw new InvitationApiError('The invitation service returned invalid data.', 502)
  }
  return value as unknown as IssuedInvitation
}

async function request<T>(path: string, body: unknown, decode: (value: unknown) => T, successStatus: number, issuance = false): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new InvitationApiError('Could not reach the invitation service.', 0, undefined, issuance)
  }
  if (!response.ok) {
    let code: string | undefined
    try {
      const payload = await response.json() as ErrorBody
      code = typeof payload?.error?.code === 'string' ? payload.error.code : undefined
    } catch { /* Use the generic status mapping. */ }
    const message = code === 'invitation_email_mismatch'
      ? 'Sign in with the verified email address that received this invitation.'
      : code === 'invitation_unavailable'
        ? 'This invitation is unavailable. Ask the workspace administrator for a new invitation.'
        : code === 'already_a_member'
          ? 'This email already belongs to a member of this workspace, so no invitation was created.'
        : code === 'invitation_exists'
            ? 'A pending invitation already exists for this email. Search for it below to revoke it before issuing a new code.'
        : code === 'invitation_conflict'
          ? 'This invitation could not be created. Check access or contact a workspace owner.'
        : response.status === 401
          ? 'Sign in to accept this invitation.'
          : response.status === 403
            ? 'Your account cannot accept this invitation.'
            : response.status === 409
              ? 'You already belong to this workspace.'
              : response.status >= 500
                ? 'The invitation service is temporarily unavailable. Try again later.'
                : 'The invitation request could not be completed.'
    throw new InvitationApiError(message, response.status, code, issuance && response.status >= 500)
  }
  if (response.status !== successStatus) throw new InvitationApiError('The invitation service returned an unexpected response.', response.status, undefined, issuance)
  try {
    const payload = await response.json() as Envelope<unknown>
    if (!record(payload) || !('data' in payload)) throw new Error()
    return decode(payload.data)
  } catch (error) {
    if (error instanceof InvitationApiError) {
      if (issuance && !error.outcomeUnknown) throw new InvitationApiError(error.message, error.status, error.code, true)
      throw error
    }
    throw new InvitationApiError('The invitation service returned invalid data.', response.status, undefined, issuance)
  }
}

export function issueInvitation(workspaceId: string, input: IssueInvitationInput): Promise<IssuedInvitation> {
  if (!uuid.test(workspaceId)) throw new InvitationApiError('Select a valid workspace before inviting someone.', 400)
  return request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`, input, decodeIssuedInvitation, 201, true)
}

export async function searchPendingInvitations(workspaceId: string, email: string): Promise<PendingInvitation[]> {
  if (!uuid.test(workspaceId)) throw new InvitationApiError('Select a valid workspace.', 400)
  return request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/search`, { email }, (value) => {
    if (!Array.isArray(value) || value.some((entry) => !record(entry) || typeof entry.id !== 'string' || !uuid.test(entry.id) || typeof entry.email !== 'string' || !invitationRole(entry.role) || typeof entry.expiresAt !== 'string' || !Number.isFinite(Date.parse(entry.expiresAt)))) {
      throw new InvitationApiError('The invitation service returned invalid data.', 502)
    }
    return value as PendingInvitation[]
  }, 200)
}

export async function revokeInvitation(workspaceId: string, id: string): Promise<void> {
  if (!uuid.test(workspaceId) || !uuid.test(id)) throw new InvitationApiError('The invitation is invalid.', 400)
  let response: Response
  try {
    response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
  } catch { throw new InvitationApiError('Could not reach the invitation service.', 0) }
  if (response.status !== 204) throw new InvitationApiError('The invitation could not be revoked. Refresh the search and try again.', response.status)
}

export function redeemInvitation(token: string): Promise<InvitationMembership> {
  if (!opaqueToken.test(token)) throw new InvitationApiError('Enter a valid invitation code.', 400)
  return request('/api/v1/invitations/redeem', { token }, (value) => {
    if (!record(value) || typeof value.workspaceId !== 'string' || !uuid.test(value.workspaceId) || !invitationRole(value.role)) {
      throw new InvitationApiError('The invitation service returned invalid data.', 502)
    }
    return value as unknown as InvitationMembership
  }, 200)
}
