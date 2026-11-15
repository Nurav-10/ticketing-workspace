import { afterEach, expect, it, mock } from 'bun:test'
import { listPrivateTeamMembers, listPrivateTeams, setPrivateTeamMember } from './team-admin-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

it('loads scoped private-team pages and changes membership with same-origin credentials', async () => {
  const page = { data: [], pageInfo: { hasMore: false, nextCursor: null } }
  const fetchMock = mock(async (_url, options) => options.method === 'POST' || options.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify(page), { status: 200 }))
  globalThis.fetch = fetchMock
  expect(await listPrivateTeams('workspace', 'cursor')).toEqual(page)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/workspaces/workspace/private-teams?cursor=cursor')
  expect(await listPrivateTeamMembers('workspace', 'team')).toEqual(page)
  expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/workspaces/workspace/teams/team/members')
  await setPrivateTeamMember('workspace', 'team', 'user', true)
  expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/workspaces/workspace/teams/team/members/user')
  expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
  await setPrivateTeamMember('workspace', 'team', 'user', false)
  expect(fetchMock.mock.calls[3][1].method).toBe('DELETE')
})

it('reports failed membership changes without claiming success', async () => {
  globalThis.fetch = mock(async () => new Response(null, { status: 403 }))
  await expect(setPrivateTeamMember('workspace', 'team', 'user', true)).rejects.toThrow('Membership could not be changed')
})

it('rejects malformed records and incomplete pagination metadata', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ data: [{ id: 'team' }], pageInfo: { hasMore: false, nextCursor: null } }), { status: 200 }))
  await expect(listPrivateTeams('workspace')).rejects.toThrow('invalid data')
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ data: [], pageInfo: { hasMore: true, nextCursor: null } }), { status: 200 }))
  await expect(listPrivateTeamMembers('workspace', 'team')).rejects.toThrow('invalid data')
})
