// Productive.io JSON:API transport. Credentials are passed in per call site —
// this layer never reads or writes them anywhere, and never puts the token in an
// error message (see `scrub`).
import type { ProductiveRecord } from './types'
import { asRecord } from './mapper'

const PRODUCTIVE_API_BASE = 'https://api.productive.io/api/v2'
const DEFAULT_PAGE_SIZE = 100
/** Safety valve so a misbehaving `links.next` cannot spin forever. */
const MAX_PAGES = 100
const RATE_LIMIT_MAX_RETRIES = 4
const RATE_LIMIT_BASE_DELAY_MS = 500
const RATE_LIMIT_MAX_DELAY_MS = 10_000

export interface ProductiveCredentials {
  apiToken: string
  organizationId: string
}

export class ProductiveApiError extends Error {
  readonly status: number | null
  /** From a Retry-After header, when Productive sends one. */
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    status: number | null = null,
    retryAfterMs: number | null = null
  ) {
    super(message)
    this.name = 'ProductiveApiError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function isRateLimited(error: unknown): boolean {
  if (!(error instanceof ProductiveApiError)) return false
  // Productive has returned the rate-limit message with statuses other than
  // 429, so the body is checked too.
  return error.status === 429 || /rate limit/iu.test(error.message)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry-After is seconds or an HTTP date; both forms are accepted. */
export function retryAfterMs(response: {
  headers: { get(name: string): string | null }
}): number | null {
  const header = response.headers.get('retry-after')
  if (header === null) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - Date.now())
}

export function isAuthError(error: unknown): boolean {
  // Why: Productive returns 403 for permission gaps even when the token is
  // valid, so only 401 means the credential itself is invalid.
  return error instanceof ProductiveApiError && error.status === 401
}

export type JsonApiResponse = {
  data?: ProductiveRecord | ProductiveRecord[]
  included?: unknown
  links?: { next?: string | null }
  meta?: ProductiveRecord
}

export type RequestInitLite = { method?: string; body?: string }

export type ProductiveTransport = {
  readonly organizationId: string
  request<T>(path: string, init?: RequestInitLite): Promise<T | null>
  /** Fetch pages of a collection, accumulating `data[]` and `included[]`, until
   *  the collection is exhausted or `maxRecords` is reached. */
  fetchPaged(
    buildPath: (page: number, pageSize: number) => string,
    options?: { pageSize?: number; maxRecords?: number }
  ): Promise<{ records: ProductiveRecord[]; included: ProductiveRecord[] }>
}

function asDataArray(value: unknown): ProductiveRecord[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : []
}

/** Append `page[number]`/`page[size]` to a path that may already have a query. */
export function withPageParams(path: string, page: number, pageSize: number): string {
  const separator = path.includes('?') ? '&' : '?'
  const params = new URLSearchParams()
  params.set('page[number]', String(page))
  params.set('page[size]', String(pageSize))
  return `${path}${separator}${params.toString()}`
}

/** Pull `page[number]` from a `links.next` URL (absolute or a bare query
 *  string), returning null when there is no further page. */
function nextPageNumber(links: JsonApiResponse['links']): number | null {
  const next = links?.next
  if (typeof next !== 'string' || !next) {
    return null
  }
  try {
    // The base only matters for parsing, never for the issued request.
    const url = new URL(next, 'https://api.productive.io')
    const raw = url.searchParams.get('page[number]') ?? url.searchParams.get('page%5Bnumber%5D')
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function totalPages(meta: ProductiveRecord | undefined): number | null {
  const raw = asRecord(meta).total_pages
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** `/data/attributes/title` or `/data/relationships/task_list` -> `title` / `task_list`. */
function fieldFromPointer(pointer: string | undefined): string | null {
  if (typeof pointer !== 'string') return null
  const last = pointer.split('/').filter(Boolean).at(-1)
  return last === undefined || last === 'data' ? null : last
}

async function readProductiveError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      errors?: { detail?: string; title?: string; source?: { pointer?: string } }[]
    }
    // Productive answers a validation failure with a bare "can't be blank" and
    // puts the field in `source.pointer`. Dropping the pointer leaves an error
    // nobody can act on.
    const messages = (Array.isArray(data.errors) ? data.errors : [])
      .map((error) => {
        const message = error.detail ?? error.title
        if (message === undefined) return undefined
        const field = fieldFromPointer(error.source?.pointer)
        return field === null ? message : `${field} ${message}`
      })
      .filter((message): message is string => Boolean(message))
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Productive request failed (${response.status})`
}

export function createTransport(
  credentials: ProductiveCredentials,
  options?: { fetchImpl?: typeof fetch }
): ProductiveTransport {
  const apiToken = credentials.apiToken.trim()
  const organizationId = credentials.organizationId.trim()
  if (!apiToken || !organizationId) {
    throw new ProductiveApiError('A Productive API token and organization id are required.')
  }
  const doFetch = options?.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new ProductiveApiError('No fetch implementation available.')
  }

  // Belt and braces: nothing this layer throws or logs may contain the token,
  // even if an upstream error echoes the request headers back at us.
  const scrub = (message: string): string => message.split(apiToken).join('[redacted]')

  /**
   * Productive answers a burst with 429 and the body "Rate limit reached. Try
   * again later"; it sends no RateLimit-* headers on success, so the only
   * signal is the failure itself. Wait out a bounded number of attempts rather
   * than surfacing a hard error the user has to retry by hand.
   */
  async function requestWithRetry<T>(
    path: string,
    init?: RequestInitLite
  ): Promise<T | null> {
    let lastError: ProductiveApiError | null = null
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
      try {
        return await requestOnce<T>(path, init)
      } catch (error) {
        if (!(error instanceof ProductiveApiError) || !isRateLimited(error)) {
          throw error
        }
        lastError = error
        if (attempt === RATE_LIMIT_MAX_RETRIES) break
        // Full jitter: a board refresh fans out several requests at once, and
        // retrying them in lockstep would just rebuild the same burst.
        const backoff = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt
        const delay = error.retryAfterMs ?? Math.random() * backoff
        await sleep(Math.min(delay, RATE_LIMIT_MAX_DELAY_MS))
      }
    }
    throw (
      lastError ??
      new ProductiveApiError('Productive rate limit reached. Try again later.', 429)
    )
  }

  async function requestOnce<T>(path: string, init?: RequestInitLite): Promise<T | null> {
    let response: Response
    try {
      response = await doFetch(`${PRODUCTIVE_API_BASE}${path}`, {
        method: init?.method,
        body: init?.body,
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'X-Auth-Token': apiToken,
          'X-Organization-Id': organizationId
        }
      })
    } catch (error) {
      throw new ProductiveApiError(
        scrub(
          `Could not reach Productive: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    }
    if (!response.ok) {
      throw new ProductiveApiError(
        scrub(await readProductiveError(response)),
        response.status,
        retryAfterMs(response)
      )
    }
    if (response.status === 204) {
      return null
    }
    try {
      return (await response.json()) as T
    } catch (error) {
      throw new ProductiveApiError(
        scrub(
          `Productive returned an unreadable response: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        response.status
      )
    }
  }

  async function fetchPaged(
    buildPath: (page: number, pageSize: number) => string,
    options?: { pageSize?: number; maxRecords?: number }
  ): Promise<{ records: ProductiveRecord[]; included: ProductiveRecord[] }> {
    const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE
    const maxRecords = options?.maxRecords
    const records: ProductiveRecord[] = []
    const included: ProductiveRecord[] = []
    let page = 1
    for (let guard = 0; guard < MAX_PAGES; guard += 1) {
      const response = await requestWithRetry<JsonApiResponse>(buildPath(page, pageSize))
      records.push(...asDataArray(response?.data))
      included.push(...asDataArray(response?.included))
      if (maxRecords !== undefined && records.length >= maxRecords) {
        break
      }
      const total = totalPages(response?.meta)
      if (total !== null && page >= total) {
        break
      }
      const next = nextPageNumber(response?.links)
      if (next === null || next <= page) {
        break
      }
      page = next
    }
    return { records, included }
  }

  return { organizationId, request: requestWithRetry, fetchPaged }
}
