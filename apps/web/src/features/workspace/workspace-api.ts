export type WorkspaceSummary = {
  id: string
  name: string
  slug: string
  role: string
}

export type TeamSummary = {
  id: string
  name: string
  key: string
  visibility: 'workspace' | 'private'
}

export type CreateTeamInput = { name: string; key: string; visibility: TeamSummary['visibility'] }

type ApiEnvelope<T> = { data: T }

export class ApiRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiRequestError('Could not reach the API')
  }
  if (!response.ok) {
    throw new ApiRequestError(`API request failed (${response.status})`, response.status)
  }
  if (response.status === 204) return undefined as T
  try {
    return await response.json() as T
  } catch {
    throw new ApiRequestError('The API returned an invalid response', response.status)
  }
}

export async function getAuthAvailability(): Promise<boolean> {
  const result = await request<ApiEnvelope<{ available: boolean }>>('/api/v1/auth/status')
  if (typeof result.data?.available !== 'boolean') throw new ApiRequestError('The API returned an invalid auth status')
  return result.data.available
}

export async function getWorkspaces(): Promise<WorkspaceSummary[]> {
  const result = await request<ApiEnvelope<WorkspaceSummary[]>>('/api/v1/workspaces')
  if (!Array.isArray(result.data) || result.data.some((workspace) => !workspace || typeof workspace.name !== 'string')) {
    throw new ApiRequestError('The API returned invalid workspace data')
  }
  return result.data
}

export async function getTeams(workspaceId: string): Promise<TeamSummary[]> {
  const result = await request<ApiEnvelope<TeamSummary[]>>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams`)
  if (!Array.isArray(result.data) || result.data.some((team) => !team || typeof team.id !== 'string' || typeof team.name !== 'string' || typeof team.key !== 'string' || (team.visibility !== 'workspace' && team.visibility !== 'private'))) {
    throw new ApiRequestError('The API returned invalid team data')
  }
  return result.data
}

export async function createTeam(workspaceId: string, input: CreateTeamInput): Promise<TeamSummary> {
  const result = await request<ApiEnvelope<TeamSummary>>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  const team = result.data
  if (!team || typeof team.id !== 'string' || typeof team.name !== 'string' || typeof team.key !== 'string' || (team.visibility !== 'workspace' && team.visibility !== 'private')) {
    throw new ApiRequestError('The API returned invalid team data')
  }
  return team
}

export function signOut(): Promise<void> {
  return request<void>('/api/v1/auth/logout', { method: 'POST' })
}
