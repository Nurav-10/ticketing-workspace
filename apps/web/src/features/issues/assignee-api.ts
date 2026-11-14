export type AssigneeOption = { id: string; displayName: string }
export type AssigneeOptionPage = { items: AssigneeOption[]; nextCursor?: string }

export async function listAssigneeOptions(workspaceId: string, teamId: string, signal?: AbortSignal, cursor?: string): Promise<AssigneeOptionPage> {
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''
  const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}/assignee-options${query}`
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', signal })
  } catch {
    throw new Error('Could not reach the team member service. Check your connection and retry.')
  }
  if (!response.ok) {
    let message = `Could not load team members (${response.status}).`
    try {
      const body = await response.json() as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch { /* Use the safe fallback message. */ }
    throw new Error(message)
  }
  try {
    const envelope = await response.json() as { data?: AssigneeOptionPage }
    if (!envelope.data || !Array.isArray(envelope.data.items)) throw new Error()
    return envelope.data
  } catch {
    throw new Error('The team member service returned an invalid response.')
  }
}
