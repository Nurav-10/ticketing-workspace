/** Typed browser client for the saved-view endpoints. Filter data is never serialized into a URL. */
export type ViewVisibility = 'private' | 'team'
export type ViewLayout = 'list' | 'board'
export type ViewArchiveMode = 'active' | 'archived' | 'all'
export type ViewSortKey = 'createdAt' | 'updatedAt' | 'priority' | 'title' | 'assignee'
export type ViewCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
export type ViewPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export type ViewGroupBy = 'none' | 'status' | 'assignee' | 'priority'

/** Fixed v1 filter grammar from apps/api/src/views/view-domain.ts. */
export interface ViewFilter {
  version: 1
  statusIds: string[]
  categories: ViewCategory[]
  priorities: ViewPriority[]
  assigneeUserId: string | null
  labelIds: string[]
  archiveMode: ViewArchiveMode
  searchTerm: string
  sort: { key: ViewSortKey; direction: 'asc' | 'desc' }
  groupBy: ViewGroupBy
  layout: ViewLayout
}

export interface SavedView {
  id: string
  workspaceId: string
  teamId: string
  /** Immutable account that originally created the view; this is not an ownership claim. */
  creatorUserId: string
  /** May be added by ownership-resolution work; never assumed to equal creatorUserId. */
  ownerUserId?: string
  name: string
  visibility: ViewVisibility
  filter: ViewFilter
  version: number
  createdAt: string
  updatedAt: string
}

export interface SavedViewPage { items: SavedView[]; nextCursor?: string }
export interface SavedViewScope { workspaceId: string; teamId: string }
export interface CreateSavedViewInput { name: string; visibility: ViewVisibility }
export interface UpdateSavedViewInput { name?: string; visibility?: ViewVisibility }

type ApiEnvelope<T> = { data: T }
type ApiErrorBody = { error?: { code?: string; message?: string } }

export class SavedViewApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'SavedViewApiError'
  }

  get isConflict() { return this.status === 409 && this.code === 'version_conflict' }
}

const root = ({ workspaceId, teamId }: SavedViewScope) =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}/views`

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const categories: readonly ViewCategory[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled']
const priorities: readonly ViewPriority[] = ['none', 'low', 'medium', 'high', 'urgent']
const sortKeys: readonly ViewSortKey[] = ['createdAt', 'updatedAt', 'priority', 'title', 'assignee']
const groupModes: readonly ViewGroupBy[] = ['none', 'status', 'assignee', 'priority']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isStringList(value: unknown, valid?: readonly string[]): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && (!valid || valid.includes(item)))
}

function decodeFilter(value: unknown): value is ViewFilter {
  if (!isRecord(value) || Object.keys(value).some((key) => !['version', 'statusIds', 'categories', 'priorities', 'assigneeUserId', 'labelIds', 'archiveMode', 'searchTerm', 'sort', 'groupBy', 'layout'].includes(key)) ||
      Object.keys(value).length !== 11 || value.version !== 1 || !isStringList(value.statusIds) || value.statusIds.length > 50 ||
      !value.statusIds.every((id) => uuid.test(id)) || new Set(value.statusIds).size !== value.statusIds.length || !isStringList(value.categories, categories) ||
      !isStringList(value.priorities, priorities) ||
      !(value.assigneeUserId === null || (typeof value.assigneeUserId === 'string' && uuid.test(value.assigneeUserId))) ||
      !isStringList(value.labelIds) || value.labelIds.length > 50 || new Set(value.labelIds).size !== value.labelIds.length || !value.labelIds.every((id) => uuid.test(id)) ||
      !['active', 'archived', 'all'].includes(String(value.archiveMode)) ||
      typeof value.searchTerm !== 'string' || [...value.searchTerm].length > 200 || !isRecord(value.sort) ||
      Object.keys(value.sort).length !== 2 || Object.keys(value.sort).some((key) => !['key', 'direction'].includes(key)) ||
      !sortKeys.includes(value.sort.key as ViewSortKey) || !['asc', 'desc'].includes(String(value.sort.direction)) ||
      !groupModes.includes(value.groupBy as ViewGroupBy) || !['list', 'board'].includes(String(value.layout))) return false
  return true
}

function decodeSavedView(value: unknown): SavedView {
  if (!isRecord(value) || typeof value.id !== 'string' || !uuid.test(value.id) ||
      typeof value.workspaceId !== 'string' || !uuid.test(value.workspaceId) ||
      typeof value.teamId !== 'string' || !uuid.test(value.teamId) ||
      typeof value.creatorUserId !== 'string' || !uuid.test(value.creatorUserId) ||
      (value.ownerUserId !== undefined && (typeof value.ownerUserId !== 'string' || !uuid.test(value.ownerUserId))) ||
      typeof value.name !== 'string' || !value.name.trim() ||
      (value.visibility !== 'private' && value.visibility !== 'team') || !decodeFilter(value.filter) ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new SavedViewApiError('The saved-view service returned invalid data.', 502)
  }
  return value as unknown as SavedView
}

async function request<T>(path: string, init: RequestInit = {}, decode: (value: unknown) => T): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
  } catch {
    if (init.signal?.aborted) throw new SavedViewApiError('Request cancelled.', 0, 'aborted')
    throw new SavedViewApiError('Could not reach the saved-view service. Check your connection and retry.', 0)
  }
  if (!response.ok) {
    let body: ApiErrorBody = {}
    try { body = await response.json() as ApiErrorBody } catch { /* Keep the safe fallback below. */ }
    const code = body.error?.code
    const message = code === 'version_conflict'
      ? 'This saved view changed since you opened it.'
      : code === 'forbidden'
        ? 'You do not have permission to change this saved view.'
        : code === 'not_found'
          ? 'This saved view is no longer available.'
          : body.error?.message || `Saved-view request failed (${response.status}).`
    throw new SavedViewApiError(message, response.status, code)
  }
  if (response.status === 204) return undefined as T
  try {
    const envelope = await response.json() as ApiEnvelope<unknown>
    if (!isRecord(envelope) || !('data' in envelope)) throw new Error()
    return decode(envelope.data)
  } catch (error) {
    if (error instanceof SavedViewApiError) throw error
    throw new SavedViewApiError('The saved-view service returned an invalid response.', response.status)
  }
}

const identity = <T,>(value: unknown) => value as T

export async function listSavedViews(scope: SavedViewScope, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<SavedViewPage> {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.cursor) query.set('cursor', options.cursor)
  const suffix = query.size ? `?${query.toString()}` : ''
  return request(`${root(scope)}${suffix}`, { signal: options.signal }, (value) => {
    if (!isRecord(value) || !Array.isArray(value.items) ||
        (value.nextCursor !== undefined && typeof value.nextCursor !== 'string')) {
      throw new SavedViewApiError('The saved-view service returned invalid page data.', 502)
    }
    return { items: value.items.map(decodeSavedView), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) }
  })
}

export async function getSavedView(scope: SavedViewScope, viewId: string, signal?: AbortSignal): Promise<SavedView> {
  return request(`${root(scope)}/${encodeURIComponent(viewId)}`, { signal }, decodeSavedView)
}

export async function createSavedView(scope: SavedViewScope, input: CreateSavedViewInput): Promise<SavedView> {
  return request(root(scope), { method: 'POST', body: JSON.stringify(input) }, decodeSavedView)
}

export async function updateSavedView(scope: SavedViewScope, view: SavedView, input: UpdateSavedViewInput): Promise<SavedView> {
  return request(`${root(scope)}/${encodeURIComponent(view.id)}`, {
    method: 'PATCH', headers: { 'If-Match': `"${view.version}"` }, body: JSON.stringify(input),
  }, decodeSavedView)
}

export async function deleteSavedView(scope: SavedViewScope, view: SavedView): Promise<void> {
  return request(`${root(scope)}/${encodeURIComponent(view.id)}`, {
    method: 'DELETE', headers: { 'If-Match': `"${view.version}"` },
  }, identity<void>)
}
