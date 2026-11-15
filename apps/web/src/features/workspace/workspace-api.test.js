import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ApiRequestError, createTeam } from './workspace-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('team creation', () => {
  it('sends the scoped team fields to the protected endpoint', async () => {
    const team = { id: 'team-id', name: 'Product', key: 'PROD', visibility: 'workspace' }
    const fetchMock = mock(async () => new Response(JSON.stringify({ data: team }), { status: 201 }))
    globalThis.fetch = fetchMock
    expect(await createTeam('workspace-id', { name: 'Product', key: 'PROD', visibility: 'workspace' })).toEqual(team)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/workspaces/workspace-id/teams')
    expect(options.method).toBe('POST')
    expect(options.credentials).toBe('same-origin')
    expect(JSON.parse(options.body)).toEqual({ name: 'Product', key: 'PROD', visibility: 'workspace' })
  })

  it('surfaces authorization failure without pretending the team was created', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 403 }))
    await expect(createTeam('workspace-id', { name: 'Product', key: 'PROD', visibility: 'private' })).rejects.toBeInstanceOf(ApiRequestError)
  })
})
