import type { TeamSummary } from './workspace-api'

export type TeamMember = { id: string; email: string; displayName: string; role: string; isTeamMember: boolean }
export type TeamAdminPage<T> = { data: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }

const root = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
const membersPath = (workspaceId: string, teamId: string) => `${root(workspaceId)}/teams/${encodeURIComponent(teamId)}/members`

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

async function page<T>(path: string, valid: (value: unknown) => value is T, cursor?: string): Promise<TeamAdminPage<T>> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
  let response: Response
  try { response = await fetch(path + query, { method: 'GET', credentials: 'same-origin', cache: 'no-store' }) }
  catch { throw new Error('Could not reach the team service.') }
  if (!response.ok) throw new Error('Could not load team administration. Check your access and try again.')
  const result: unknown = await response.json().catch(() => null)
  if (!isRecord(result) || !Array.isArray(result.data) || !result.data.every(valid) || !isRecord(result.pageInfo) || typeof result.pageInfo.hasMore !== 'boolean' || (result.pageInfo.hasMore ? typeof result.pageInfo.nextCursor !== 'string' || result.pageInfo.nextCursor.length === 0 : result.pageInfo.nextCursor !== null)) {
    throw new Error('The team service returned invalid data.')
  }
  return result as TeamAdminPage<T>
}

export function listPrivateTeams(workspaceId: string, cursor?: string): Promise<TeamAdminPage<TeamSummary>> {
  return page(`${root(workspaceId)}/private-teams`, (value): value is TeamSummary => isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.key === 'string' && value.visibility === 'private', cursor)
}
export function listPrivateTeamMembers(workspaceId: string, teamId: string, cursor?: string): Promise<TeamAdminPage<TeamMember>> {
  return page(membersPath(workspaceId, teamId), (value): value is TeamMember => isRecord(value) && typeof value.id === 'string' && typeof value.email === 'string' && typeof value.displayName === 'string' && typeof value.role === 'string' && typeof value.isTeamMember === 'boolean', cursor)
}
export async function setPrivateTeamMember(workspaceId: string, teamId: string, userId: string, member: boolean): Promise<void> {
  let response: Response
  try { response = await fetch(`${membersPath(workspaceId, teamId)}/${encodeURIComponent(userId)}`, { method: member ? 'POST' : 'DELETE', credentials: 'same-origin', cache: 'no-store' }) }
  catch { throw new Error('Could not reach the team service.') }
  if (response.status !== 204) throw new Error('Membership could not be changed. Refresh the list and try again.')
}
